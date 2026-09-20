# Invariant rationale

The rules live in [CLAUDE.md](../../CLAUDE.md); this file keeps the full reasoning behind the ones whose "why" runs longer than the rule. Most of these encode a
failure that already happened or an attack that was closed deliberately — read the relevant section before changing one.

## `registry.json` has exactly one writer, and a linked worktree registers its main tree

`~/.backlog-manager/registry.json` has exactly one writer: `skills/backlog/tools/backlog.mjs` (`init`/`new` upsert, plus `unregister`, the one removal path —
the upsert has no undo, and the repair for an entry that should never have been written has to live behind the same single writer, not in the server and not in
a text editor). The server re-reads it per request, never writes, never caches.

**What gets written is `registryRoot(root)`, not the root `resolveRoot` returned**: those are the same path in every case but one, and that one is bug-17 — a
per-item orchestrator worktree registered as a standalone project (`.worktrees/bug-13`, name "bug-13"), a phantom entry that outlived the directory it named,
since a worktree is deleted the moment its item merges.

`resolveRoot` is not at fault and is deliberately unchanged: an execute session inside a worktree MUST resolve `backlog/` to that worktree's own copy, which is
why its walk accepts a `.git` file at all. The registry is the one consumer of that root for which a worktree is the wrong answer — it stores absolute host
paths the board, the item-body allowlist and the orchestrator all key on — so the mapping sits at that seam alone.

A linked worktree registers its **main tree** rather than being refused, because the worktree's items merge back into it and it is almost always already
registered, making the upsert a harmless name refresh; `null` (register nothing, non-fatal stderr note) is reserved for a bare main repo, where no main-tree
path can be named.

The discriminator is `linkedWorktreeInfo`, a **second copy** of `orchestrate.mjs`'s function — duplicated because one skill's `tools/` may never import
another's, and keyed on a `commondir` entry in the `gitdir:` target, never "`.git` is a file": a submodule working tree is a file too and must keep registering
as itself. Both suites build a real submodule so a future git that changes that layout fails loudly in both places.

## The orchestrator's run file has exactly one writer, one reader — the same relationship the registry has

The run file (`run.json`) is `orchestrate.mjs`'s entire state model for one project's queue — the queue itself, each item's stage, the attention list,
timestamps — and every other consumer treats it as strictly read-only. `server/src/orchestrator/orchestrator.service.ts` re-derives `orchHome()` with its own
copy of the same function rather than importing the `.mjs` tool (a Nest service cannot import one), so the two implementations are pinned to resolve identically
by a comment on each side, not by the type system — the risk that comment names directly: a mismatch would have the board watching an empty directory while the
CLI writes real runs a few characters away. `OrchestratorService.runs()` calls `orchHome()` fresh on every request and never caches — echoing RegistryService's
own reason for the same choice (a skill can act on its file at any moment; a cache would show something stale) but for an even more time-sensitive case: a
running `orchestrate.mjs` re-stamps `run.json` on every heartbeat, and the entire point of `GET /api/orchestrator/runs` is to let the board watch that happen
live — a cache would show a run frozen at whatever moment the server last happened to read it. Neither the server nor the client ever writes a byte of it;
`orchestrate.mjs`'s own "Hard limits" section states the rule for the skill side too — never hand-edit the run file, never `rm` it to get past an exit code `4`,
never write it from the server or the client.

The same one reader now also covers `runs/`, the archive directory `cmdInit` writes to when a new run supersedes a finished one (`archiveStem`,
`orchestrate.mjs`) — before this feature nothing ever read it back, so a project's whole run history sat on disk with no surface showing it beyond the drawer's
own `pastRuns` count. `OrchestratorService.archive()` walks every project directory under `orchHome()`, reading both `run.json` and every `runs/*.json` sibling
through the same skip-and-warn `readOneRun` helper `runs()` already used for the current file alone, and returns them flattened across all projects with
`current: boolean` marking which entry is the active `run.json` — a run file's own contents say nothing about where it lives (`runId`/`status`/`startedAt` are
identical in shape whether the file is `run.json` or `runs/<runId>.json`), so the flag is the only way a client can tell "the run still being superseded" from
"one of however many came before it." Verification tails are stripped to `{cmd, ok}` (`VerificationSummary`, `shared/types.ts`) before the payload leaves the
service, because a tail is roughly 90% of a run file's bytes — a real 19KB file is mostly test output — and `archive()` has to hold every run a project has ever
produced in one response rather than just its current one; `archivedRun(project, runId)` exists for the one run a reader actually opens, and serves that file
verbatim, tail included. Two guards run before either caller-supplied value reaches the filesystem: `RUN_ID_RE` (`^run-\d{8}-\d{6}(-\d+)?$`) rejects anything
not shaped like a run id, closing off traversal before the first `path.join`, and `encodeURIComponent(project)` is then checked for string equality against an
entry `readdirSync(orchHome())` actually returned — the same allowlist-by-listing shape `server/src/items/allow.util.ts` uses for item bodies, so an
unregistered project path is never joined into a probe, only compared against names the filesystem already listed. Every failure this can produce — a malformed
runId, an unknown project, no archived file and no matching `run.json` either — collapses to the same `null`, and the controller turns all of them into the same
404: `GET /api/items/body`'s own stance, that the caller has no business learning which check failed. Both new methods call `orchHome()` fresh per request
exactly as `runs()` does, and cache nothing — the single-writer rule above is untouched by any of this; `orchestrate.mjs` remains the only process that ever
writes a byte under `orchHome()`, this service only reads more of what was already there.

### A run's sidecars are archived beside its run file (task-31)

Until task-31, `cmdInit` archived `run.json` and nothing else. Everything else a run produced — `<dir>/logs/`, `<dir>/reviews/`, `<dir>/verify/`,
`<dir>/questions/`, and `<dir>/prompts/`, at the time a directory one driver had invented for itself — stayed flat and project-scoped, keyed by **item id**. An
item dispatched again in a later run therefore overwrote its own first attempt's transcript, reviewer report and verify output, silently. That is not
hypothetical: bug-2 in this repo ran in three runs and task-9 in claude-agents-dashboard in two, and only the last log of each survives.

`init` now moves that run's sidecars into `runs/<stem>/` at the same moment it moves its run file to `runs/<stem>.json`. Both names come from one `archiveStem`
call, which is why nothing in the run file records where the evidence went: the two artefacts are siblings minted from one stem, so the location is derived from
the archive path exactly the way "Groomed" and "Board-versus-Archive" are derived rather than stored. A `sidecarDir` field would be a second copy of a fact the
path already carries, and the run file has one writer precisely so there is one authority per fact.

**A denylist of two, not an allowlist of five.** The mover skips `run.json` (renamed by `cmdInit` itself moments later) and `runs` (which it would otherwise
bury inside its own newest entry), and moves everything else. The sidecar directories are created by _drivers following SKILL.md prose_
(`mkdir -p "<dir>/logs"`), never by the tool, so the set of names is open by construction — `prompts/` first existed on exactly one project on this machine
because one driver invented it unprompted, and bug-31 then made it prescribed — SKILL.md §5 and §7 now name `prompts/<id>-retry-1.txt` and
`prompts/<id>-fix-<n>.txt` as the way a run-composed prompt reaches a resumed session at all. The denylist carried that change without an edit, which is the
property it was chosen for. An allowlist minted today would silently drop whatever the next prose edit names, which is the very evidence loss this exists to
close. Excluding `runs/` enforces a rule SKILL.md §2 already states ("stay out of `<dir>/runs/`") rather than inventing one.

**Sidecars move first, `run.json` renames last, and the order is the design.** A crash between the two leaves the sidecars under `runs/<stem>/` with `run.json`
still flat and still `done` — so the next `init` resolves the _same_ stem (`archiveStem` checks `<stem>.json` alone, which is still free), merges whatever
sidecars remain into the directory already there, and completes the rename. Self-repairing. The other order is not: renaming the run file first and crashing
leaves `existing === null` on the next init, so the whole archive block never runs again and the sidecars are overwritten by the very run that was supposed to
preserve them. This is also why the collision check is deliberately _not_ widened to "`<stem>.json` **or** `<stem>/` is free" — that would split one run's
evidence across `<stem>/` and `<stem>-2.json` permanently, turning the repair into the failure. A name already present in the destination is skipped with a
stderr warning and never overwritten; `renameSync` onto an existing name is an error on some platforms and a silent replace on others, and neither is a thing to
do to archived evidence.

**Best-effort, never fatal.** Each move is its own `try`; a failure warns and the archive continues. `init`'s contract is that a bad call writes nothing and a
good call ends with a valid `run.json`, and failing a real run over evidence bookkeeping would trade the run for a filing error.

**Why moving a live child's pid file is safe.** `logs/<id>.pid` and `verify/<id>.pid` can name a process that is still running when a run dies. They are safe to
move for one reason only: `init` refuses any run whose status still reads `running` — fresh or stale — with exit `4`, and `init` is the only command that
archives anything. A crashed run stays `running` until a `--resume` or `--abort` deals with it, so no later run can sweep a resume's paths out from under it.
`references/recovery.md` says this at the point a resume reads those flat paths, because that is where a reader needs it.

**Orphaned sidecars are a deliberate non-goal.** Archiving happens inside `if (existing)`; with no `run.json` there is no run to name, so flat sidecars left by
a run that never wrote a run file are not moved and can still be overwritten. Inventing `runs/orphan-<newRunId>/` would file evidence under a run id that never
produced it, and a run that left no record of itself has no better name to offer.

**One filter, two readers, server side.** `runs/` is a mixed listing of files and directories for the first time, and both readers of it were wrong the moment
it became one: `countPastRuns` returned `readdirSync(...).length`, so the drawer would print "4 past runs" for two, and `archive()` handed every entry to
`readOneRun`, whose `readFileSync` throws `EISDIR` on a directory and logs a skip warning per archived run per request — on a route the Runs view fetches on
mount and on every window focus. `archivedRunFiles` is the single implementation of "which entries under `runs/` are run files", read by both, for the reason
`isStale`/`leavesBoard` are one function: two expressions that merely agree are two chances to disagree later. `archivedRun()` needs no filter at all, because
it probes the exact path `runs/<runId>.json`, which a sibling directory named `<runId>` can never answer to.

## `~/.backlog-manager/retro/` has exactly one writer, and the retro never writes run state

**task-30.** This is the third directory under `~/.backlog-manager/` that a tool owns outright, and it keeps the same relationship the other two do:
`registry.json` has `backlog.mjs`, `run.json` has `orchestrate.mjs`, and `~/.backlog-manager/retro/` has `retro.mjs record`. `$BM_RETRO_HOME` overrides it for
exactly the reason `$BM_ORCH_HOME` exists — so a test process, or somebody poking at the tool by hand, can never write into a real machine's history.

**`sweep` opens the retro home, and it opens it read-only.** That is the one crossing into the directory `record` owns, and it exists because a retro's whole
value is the comparison: "fix loops are 38% of dispatched items" is a number, and "31%, after task-28 landed" is a finding. The deltas need the newest record,
so `sweep` reads it — and reading it is all it does. The write stays in `record`, behind one command a session calls once at the end.

**The whole read surface is four homes, each env-overridable, and `sweep` writes none of them.** `$BM_ORCH_HOME` (the run state, the subject), `$BM_RETRO_HOME`
(the previous record, for the deltas above), `$BM_REGISTRY_FILE` (read once, so the report can print a project's name beside its path — a broken or missing
registry yields an empty name map rather than stopping a sweep that has perfectly good run state to report) and `$BM_CLAUDE_PROJECTS` (one driver transcript per
run, by recorded lease id). Four rather than three because the registry is easy to forget: it contributes nothing to a single number in the report, which is
exactly why a claim that `sweep` opens "nothing but the run state and a driver transcript" reads as true and is not. The overrides exist for one reason each
tool here shares — a test process must never be able to read, and `record` must never be able to write, a real machine's state.

**`record` refuses to overwrite (exit `2`), and that is not a safety interlock — it is what makes a record evidence.** A summary that can be edited after the
fact is a summary; a file that can only be superseded is a measurement. The fix for a record you disagree with is the next sweep, which will carry both its own
numbers and the deltas against the one you disagree with. Exit `2` rather than a `1` for the same reason `orchestrate.mjs`'s `6` and `7` are not `1`s: a `1`
means "fix this call and retry", and this call must never be retried.

**Nothing under the run-state directory is ever written.** `run.json` keeps its single writer, and the whole of `backlog-retro` is a reader of it — a historian
rather than the live reader `server/src/orchestrator/` is. The sidecar directories, the reviews and the verify statuses are read the same way, fresh per call
and never cached.

**One transcript, by recorded id, and never a search.** The execute sessions each end their `logs/<id>.jsonl` with a `result` event carrying the cost the CLI
actually billed, so there is nothing to gain by opening their Claude Code transcripts and a spec-level non-goal against doing it. The orchestrating session is
the exception: nothing records its spend at all, and on the 2026-09-06 hand sweep it came to roughly a third of the bill. So the tool opens exactly one file per
run — `~/.claude/projects/<key>/<driver session id>.jsonl`, where the id comes from bug-19's driver lease on the run file itself. Every run from before that
lease reads `no-lease` and its driver is reported as **unmeasured, never as free**; the report says that once, with a count, rather than once per run.

**Dollars the tool did not observe are marked, every time they are printed.** Only a `total_cost_usd` on a `result` event is measured. The driver's spend is
priced from four per-token rates fitted by ordinary least squares over the sessions that did report one, requiring at least eight of them, shipping
`maxResidualUsd`, and carrying `estimated: true` in JSON and `est.` in text. Fitted rather than tabulated because a hard-coded price table goes stale silently
the day pricing moves; marked because a reader who cannot tell the fitted third of the bill from the billed two thirds is being misled by the report rather than
by the pipeline.

**The labels are the session's, the set is closed, and the tool enforces it.** Whether a reviewer's Important finding was prose drift, a test that could not
fail, or a real defect is the one judgement in a retro, and `record` validates it against `drift | red-proof | defect | other` (and a candidate's status against
`filed | declined | deferred`), refusing with exit `1` and writing nothing. The point is the next sweep: the comparison is arithmetic over the recorded strings,
and one `nit` or `Drift` silently becomes a fifth category neither sweep counts, so the difference reads as improvement. `other` exists so there is always a
correct answer that is not a new word.

**One thing the design predates.** The spec describes the sidecar directories as flat, one set per project, a later run's files replacing an earlier run's.
task-31 landed between the spec and the build: a finished run's sidecars are now archived into `runs/<archiveStem>/` beside its run file, so a sweep that read
only the project directory's own `logs/` would see the live run's sessions and nothing else. The tool reads both locations. What it does NOT do is treat an
archive directory as an attribution — the first archive after task-31 swept 74 transcripts belonging to a dozen runs into one stem — so a session is still
joined to an item by `(project, itemId)`, still attributed to the latest run that dispatched it, and an item two runs dispatched still produces the `collision`
caveat.

Spec: [2026-09-06-backlog-retro-design.md](../superpowers/specs/2026-09-06-backlog-retro-design.md).

## A pause request is a file the server writes and the tool reads

**task-17.** Everything else under `~/.backlog-manager/` travels tool → server: `backlog.mjs` writes `registry.json`, `orchestrate.mjs` writes `run.json`, and
this server reads both and writes neither. The pause request is the one file that travels the other way — the server writes
`~/.backlog-manager/settings/orchestrator-control/<encodeURIComponent(project)>.json` (`{ runId, requestedAt }`, atomically, `$BM_ORCH_CONTROL_HOME` to
override), and `skills/backlog-orchestrate/tools/orchestrate.mjs` reads it at its two dispatch gates.

`POST /api/agents/pause` (`{ project, cancel? }`, origin-guarded, **independent of `BM_AGENTS`** and never calling the dashboard — a pause is a fact on this
machine's disk, and gating it on that switch would mean a run started while agents were on could never be stopped after they were turned off) writes
`~/.backlog-manager/settings/orchestrator-control/<encodeURIComponent(project)>.json` — `{ runId, requestedAt }`, `$BM_ORCH_CONTROL_HOME` to override.

**Why `settings/`, when it is not a setting.** That subdirectory is already the read-write nested mount inside an otherwise read-only `~/.backlog-manager` (see
"The settings-file exception" below) — it is the only ground this process can write in the container. A control directory anywhere else would either be
unwritable there or need a second nested mount for one small file, and a second mount is a deployment fact a future reader has to discover the hard way. The
directory is chosen for writability; the name overstates what it holds, and `pause-control.util.ts`'s own header says so out loud.

**Why a file and not a field on `run.json`.** That file has exactly one writer. A pause request starts in a browser, reaches this server, and has to arrive at a
headless session that may be minutes into a `claude -p` child; the filesystem is the only channel between those two processes. A second writer on `run.json`
would trade a well-understood single-writer guarantee — the thing the orchestrator's whole crash recovery rests on — for a lost-update race against a run
re-stamping its own heartbeat every few turns.

**The effectiveness predicate is derived on both sides, never stored:**

```
control.runId === run.runId &&
Date.parse(control.requestedAt) > Date.parse(run.unpausedAt ?? run.startedAt)
```

Missing file, unparseable file, missing or non-string field, unparseable date → not effective, on both sides, without throwing. The `runId` clause stops a
request that outlived its run from pausing the NEXT run of the same project. The timestamp clause is what RETIRES a request: `unpause` stamps `unpausedAt`, the
request falls behind it, and a resumed run does not pause itself again at its first dispatch gate — forever, which is what a delete-only retirement would have
risked, since `resume()`'s own `clearPauseRequest` is tidiness and a spawn that never reaches the session leaves the file behind. Derived rather than stored for
the reason the watchdog's `exhausted` flag is: a stored verdict whose inputs all move underneath it is the bug class, not just that one bug. And a hand-typed
`/backlog-orchestrate --resume` never passes through this server at all, so a verdict this server computed once could not be updated for it.

**The gates live in the tool, and cover exactly two stages.** SKILL.md is re-read on every one of a run's several hundred turns and prose drifts across them; an
exit code does not — the same division of labour the branch-mode `stage <id> merged` refusal already keeps. `preflight` and `dispatched` are the two calls that
START work on an item: the first creates the worktree, the second spawns the child. Every stage past them describes an item already in flight, and refusing one
would strand half-finished work in a worktree nobody is coming back to. "Stop at the next item boundary" is precisely the boundary those two calls sit on, and
§4's own ordering (record the dispatch, then spawn) is what makes the second gate land before a child exists.

**Only on a TRANSITION.** `item.stage !== stage` is part of the gate. A re-stamp of a stage the item already occupies — `stage <id> dispatched --session s1`
after the child exists, which is exactly how §4 records a session id — must never be refused, or there would be a live `claude -p` process the run file has no
id for. Strictly worse than letting the item run to its own end, which is what the run does before it finishes `paused`.

**Exit `6`, not `1`.** A `1` means "this call was wrong, fix it and retry". A `6` means "this call was right and the run is being asked to stop": the reaction
is a different command entirely, `finish --status paused`. Nothing is written on a `6`.

**`unpause` is its own command.** `heartbeat` is a pure `updatedAt` re-stamp a run makes hundreds of times, and it must never change a status — folding "and
un-pause if paused" into it would give every routine heartbeat the power to resurrect a run somebody deliberately stopped thirty seconds ago. `unpause` writes
`status: 'running'`, `unpausedAt` and `updatedAt` from ONE clock reading: the first is what the predicate compares a request against and the second is what
freshness is measured from, and two readings would open a window in which a request landing between them is judged against the wrong one.

**The watchdog needs no change, and two tests say so.** The sweeper walks `running` runs; a paused run is not one. That is the whole reason `paused` is a fifth
STATUS rather than a flag beside `running` — everything that already branches on "is this run still going" (the sweeper, `init`'s archive rule, `runClaimBlock`)
gets the right answer for free. `test/watchdog-sweep.test.ts` pins both halves: a paused run stands the sweeper down with one `idle` event, and a CRASHED run
with a pause request waiting for it is still resumed — a request is not a pause, and a run that crashed before reaching a gate never saw it.

**`init` archives a `paused` run like a `done` one.** It refuses only a file that still says `running`, so a person who gives up on resuming can start fresh
without any special case.

**The controls are one component on two surfaces, behind one gate.** `client/src/components/RunControls.tsx` was hosted by the board's run drawer and the Runs
view's detail pane — two lazy chunks that may not import from each other, which is why it sits at the top level of `components/` like `lib/view-keys.ts` does.
task-37 deleted the run drawer (the redesign's §8.3: the run's detail is the Runs page's own sheet, never a second copy on the Board), so it has one host today
and the top-level placement is what the second one — the Runs detail head that task 3 builds — will compose without moving it. `resumeGate` (`shared/agent.ts`)
is the single environment-half gate both hosts call, hoisted out of `BoardView`'s own three inline lines: two expressions that merely agree is the failure
`watchdogStoodDown` already records.

**Resume for a CRASHED run is behind `watchdogStoodDown`, wherever it is drawn,** because the watchdog may be about to spawn one itself. A paused run was never
a watchdog subject, so `RunControls` renders nothing for a crashed run and the paused control carries no watchdog clause and no watchdog condition on its
button. Do not "align" the two.

It lived on `RunStrip`'s crashed strip until task-37, which deleted the strip; the redesign's §8.4.1 moves it to the Runs detail sheet's head, alongside the
paused Resume that is already there, so neither state has two Resumes to keep in agreement. Between task-37's merge and task 3's there is **no crashed-run
Resume on the client at all** — a lost affordance (resume by hand from a terminal) and not a lost guarantee, because the hazard the gate exists for is a SECOND
spawn and a client offering none cannot cause one.

**`noteResume` keeps the poll alive for three minutes, and closes one gap without closing another.** `RESUME_POLL_GRACE_MS`
(`client/src/hooks/useOrchestratorRuns.ts`) exists because a paused run is neither fresh nor running, so nothing else would poll it after a Resume click — and a
resumed session takes ninety seconds to several minutes to reach its first heartbeat. It expires on its own so a resume that never started cannot pin a tab to
polling. What it did NOT close, until bug-19: two browser tabs could both click Resume on the same run, since the `resuming` placeholder is per-tab state and
`resume()` refused a _fresh_ run rather than a second resume of a stopped one. The server-side resume lock is what closes that (see below); the mark's own job
is unchanged.

**The mark ends on `running` AND `fresh`, not on `running` alone** (bug-19). A crashed run _is_ `status: 'running'` with a stale heartbeat — that pair is
`isCrashed` — so the original end condition was already satisfied the instant the mark was written on the one surface that most needed it. The crashed strip's
Resume button came back on the very next payload, ~90s before the resumed session could possibly have heartbeated, and a person looking at an unchanged strip
clicked again: that is occurrence 1 of bug-19, three spawns inside ten seconds. Freshness costs the paused case nothing, because `unpause` writes `status`,
`unpausedAt` and `updatedAt` from one clock reading, so a just-unpaused run is fresh by construction.

## `backlog-orchestrate` is the only skill that commits or merges

Every other skill in this repo edits item files and nothing else; `backlog-orchestrate` is the first, and by this rule the only, one that touches git history at
all. It can, because of what it alone controls: `backlog-execute`'s "never commits, never pushes" limit exists because a headless execute session runs inside a
tree it does not own, and staging there could sweep up work that has nothing to do with it — an unscoped `git add` in the user's own checkout is not a call any
skill gets to make. The orchestrator's worktree is different by construction: `git worktree add .worktrees/<id> -b backlog/<id> <base>` creates a tree that
holds exactly one item's work and nothing else, so `add -A` inside it is safe in a way it never is in the main tree — the skill says so explicitly at the commit
step rather than leaving the asymmetry to be inferred. The commit itself is conventional-commit shaped, names the orchestrator as committer in the body (so
`git log` never implies a human read the diff before it existed), and lands on `backlog/<id>` alone.

The merge target is **derived, not fixed**. It is `git -C "<base tree>" merge --no-ff --no-edit backlog/<id>`, where `<base>` is the run's own recorded base
branch (`main` for a run that asked for nothing else) and `<base tree>` is whichever working tree currently has `<base>` checked out — see
[the merge happens in whichever tree holds the base](#the-merge-happens-in-whichever-tree-holds-the-base-and-the-run-removes-only-the-tree-it-made) for why that
tree has to be found rather than created. It is refused — parked, not forced — unless that tree is first verified to be on `refs/heads/<base>`; a run never
checks out a branch in a tree it does not own, either. No branch other than the run's base is ever a merge target, and no tree other than the one holding it is
ever committed to. Force-push and history rewrite stay off the table entirely.

**Push is no longer off the table, and the narrowing is exactly one sentence wide (task-47).** For a TRACKER project — and only for one — this skill is also
the only skill that pushes: `git -C "<base tree>" pull --ff-only origin <base>` before each item's worktree, `git -C "<base tree>" push origin <base>` after
each merge, and `git push -u origin backlog/<n>` from the item worktree under branch mode. For a files project nothing changed and publishing remains the
user's call, merge commits or otherwise.

The reason a tracker project is different is not a change of taste: it is that the project is SHARED by definition. Its items are issues every machine reads,
so a merge that stayed on one laptop would be a run reporting `merged` for work nobody else can see — the same second-source-of-truth failure the whole
tracker-backed direction exists to remove. That is also why the push sits between the merge and `stage <n> merged`: the tool cannot see a push, so the close
is tied to the stage, and the driver calls it only once the push has succeeded.

**A rejected push parks and never degrades**, and it is the one place the classifier-denial rule does not apply. A denied MERGE degrades the run to branch mode
because nothing landed; a denied or rejected PUSH follows a merge that HAS landed, so staging the item `branched` would write a falsehood into the run file and
into the summary a person reads afterwards. See
[a classifier denial degrades the run](#a-classifier-denial-degrades-the-run-every-other-merge-failure-parks) for the rule this is the exception to.

## The merge happens in whichever tree holds the base, and the run removes only the tree it made

A run's **base** is the branch it gates its queue at, cuts each item worktree from, and merges each finished item into — `main` unless the run was started with
`--base <ref>`. It exists so a phased experiment (the tracker-backed backlog, the FE redesign) can be built item by item, each one starting from the previous
one's result, without `main` being written to until a human decides it should be. Branch mode is not a substitute: it leaves every item on its own
`backlog/<id>` branch with nothing integrating them, so the second item never builds on the first.

**A worktree dedicated to the base cannot be the uniform answer, because git refuses to check one branch out twice.** Measured, not assumed:

```
$ git worktree add /tmp/probe-main main
fatal: 'main' is already used by worktree at '/Users/andrejajevtic/Documents/custom-projects/backlog-manager'
```

`--force` is not the way round it. Two trees on one branch is exactly the state the skill's "this run's authority stops at worktrees it created itself" rule
exists to avoid: the second tree's HEAD moves under the first, and an unattended run has no way to know what the person in the first tree was doing. So the rule
is not "merge in a base worktree", it is **merge in whichever tree has `<base>` checked out** — resolved per merge with `git worktree list --porcelain`, into
three outcomes that are exhaustive:

1. **A tree holds it** — merge there. For a `main`-based run on an ordinary machine that is the main tree, so the resulting commands are byte-identical to the
   pre-`--base` ones except for an explicit `-C`.
2. **No tree holds it, and one can be created** — the run creates `.worktrees/_base-<sanitised ref>`, merges there, and removes it when the run finishes. The
   ref is sanitised (every character outside `A-Za-z0-9._-` becomes a `-`) because a branch name may contain `/`; the `_base-` prefix cannot collide with an
   item worktree, since every id `backlog.mjs` mints begins with `bug-`, `idea-`, `task-`, `ref-` or `oos-` and none begins with `_`.
3. **No tree holds it and one cannot be created** — park. This is the case that is easy to miss and the reason the resolution is not a single scan: a worktree
   **mid-rebase reports `detached`** in `--porcelain`, so the branch-line scan finds nothing, while git still knows that tree owns the branch and refuses the
   `worktree add` with `fatal: '<base>' is already used by worktree at '<path>'`. Measured. So outcome 3 is detected by the create failing, never by the scan,
   and the park detail quotes git's own message because it names the tree the scan could not.

**The run removes a base worktree only if it created it** — outcome 2 and nothing else. This is not a second rule beside "authority stops at worktrees it
created itself"; it is that same sentence applied to a directory that happens to hold the base. A worktree the person made is theirs, however convenient it
would be to tidy up, and a run that removed one would be deleting a working tree its owner may have uncommitted work in.

**"The main tree" and "the tree holding `main`" are not synonyms**, and conflating them is the defect this whole section exists to prevent. The main tree is the
project's original checkout — the one the registry points at, the one `orchestrate.mjs` refuses to run outside of — and it stays the main tree whatever branch
it holds. The base tree is wherever `<base>` happens to be right now. On a default run they are one directory; on a `--base` run they are two, and every rule
below has to name the right one: the `symbolic-ref` precondition and the dirty-path overlap probe both follow the merge into the **base** tree, because what can
refuse a merge is the state of the tree being written to. A dirty main tree cannot block a merge that is not happening there.

**And so does everything that follows the merge — every cleanup command belongs in the tree that merge happened in** (bug-38). Two of them kept the pre-base
spelling, where `$PWD` was correct only because the base was always `main`: `git branch -d backlog/<id>`, and the `git diff --name-only HEAD^1 HEAD` that
§9's runner-fix pickup reads. Both are HEAD-relative — `branch -d` has no `--merged-into` and tests reachability from the HEAD of the repository it runs in, so
the invoking tree _is_ the parameter — and the project root's HEAD is `main` while the merge commit is on `<base>`. Measured on run-20260918-081422: `error:
the branch 'backlog/task-45' is not fully merged`, one line after `Merge made by the 'ort' strategy`, for a branch `git branch --merged feature/tracker-backed`
listed.

The leftover branch was the small half. The large half was the sentence attached to it, which told the driver a refusal proved the merge had not happened —
wrong in the direction that stops a healthy run, on every item of every `--base` run, since a driver that believes the merge failed has every reason to
re-merge or park an item already in the base. So the reading is now stated against the tree: a refusal **from the base tree** is real evidence of a missing
merge, a refusal from anywhere else is evidence only of a misaimed command, and `git branch --merged <base> | grep backlog/<id>` settles which before either is
believed.

**The line between the two kinds of command is whether it DEPENDS on the HEAD of the tree it runs in — never whether it names it.** `branch -d` is the
counterexample that decides the wording, and it is the very command this bug is about: it contains no `HEAD` anywhere and is entirely HEAD-relative, because
with no `--merged-into` the only thing it can measure reachability from is the invoking tree's HEAD. `branch --merged`, `branch --contains`, a bare `diff` and
a `status` are the same shape. A criterion of "names HEAD" would license every one of them at the project root, which is bug-38 reinstated. The commands that
genuinely may stay there are HEAD-independent by construction, and the list is short: `show-ref --verify refs/heads/…` (a ref lookup by full name), every
`worktree` verb (repo-wide administration), and a `diff`/`log` given an explicit `<base>...backlog/<id>` range — the range being part of what makes it safe,
not incidental to it.

So `orchestrate.test.mjs` guards that list as a **closed allowlist** rather than hunting the bad shape: a text guard cannot decide HEAD-dependence, which is a
fact about git's semantics and not about the string, but it can fail closed. Every `git -C "$PWD"` line in SKILL.md must match one of the four permitted
shapes, each recorded there with the reason it is HEAD-independent, and anything else goes red until whoever added it works out which side of the line it
falls on. That is the honest generality available here, and it is the one that catches the command nobody has written yet — the first version of the guard
looked for `$PWD` lines mentioning `HEAD`, which the reverted `branch -d` passed.

Both halves of the base's own validity are checked twice, in the same order, by `resolveBase` (`agents.service.ts`) on the way in and `assertUsableBase`
(`orchestrate.mjs`) at `init`. Neither copy is redundant: the endpoint's exists to refuse a bad request **before** it spawns a headless session, and the tool's
exists because a terminal is not the endpoint. The order is deliberate, and the honest reason is a downstream one: `git check-ref-format --branch` runs first
**not** because `git show-ref --verify` would otherwise read the value as an option — it interpolates into `refs/heads/<base>`, which can never begin with a
`-`, and measuring confirms that check alone refuses every value the name check does — but because a base that survives validation is substituted for `<base>`
in SKILL.md's own shell commands (`git worktree add … <base>`, `git -C … merge --no-edit <base>`), where a leading `-` or embedded whitespace genuinely would
be read as an option or split an argument. Proving the string well-formed before anything records or composes it is what keeps that safe; running the check
first is also what makes a refusal say "that is not a ref name" rather than "no such branch". Neither check alone is the rule: measured,
`check-ref-format --branch` **accepts** `origin/main`, a 40-hex SHA and any unknown name, all three of which only `git show-ref --verify` then refuses. A run merges **into** its base, and only a local branch can move — so a tag, a SHA and a remote-tracking ref are all refused, and a missing branch is a
refusal rather than an instruction to create one.

## Undoing an already-completed orchestrator merge is `git revert -m 1`, never `git reset --hard`

This was proved empirically before the skill was written, not reasoned out in the abstract: a pre-implementation spike ran `git reset --hard` to undo a
completed test merge, and it silently discarded an unrelated, uncommitted modification sitting in the main tree along with the merge — gone with no reflog entry
to recover, because that modification had never been staged or committed in the first place. The identical scenario undone instead with
`git revert -m 1 --no-edit <merge-sha>` left the unrelated modification byte-for-byte intact. An unattended run can never prove the user's main tree is clean at
the moment it needs to undo a merge, so the choice is not between a tidy history and a messy one — it is between a revert commit's noisier `git log` and a tool
that can destroy work nobody backed up. `-m 1` names the first parent, `main` as it stood immediately before the merge in question, which is what "undo the
branch I just merged" actually means for a merge commit (a plain `git revert` on a merge commit refuses without `-m` — a merge has more than one parent and
nothing to default to). This rule is only about a merge that already landed; a conflict discovered _during_ the merge attempt is a different situation with its
own answer, `git merge --abort`, which leaves nothing to revert because nothing ever committed.

## Merge mode is run-scoped, and a malformed one is a 400

On 2026-09-03 a board-spawned `claude-agents-dashboard` run finished four items — reviewed, `test` + `typecheck` + `build` green on all four — and merged none
of them. Every merge attempt answered _"Permission for this action was denied by the Claude Code auto mode classifier."_ Two earlier runs, one on the same
project and one on this one, had issued the identical `git -C "$PWD" merge --no-ff --no-edit backlog/<id>` and merged seven items between them. Neither project
had a `permissions.allow` entry at the time; the dashboard's `.claude/settings.json` carrying `Bash(git merge:*)` is dated after the failure, staged and never
committed. **Nothing about permissions differed between the runs that merged and the run that did not** — auto mode is a per-call model classifier and its
verdict on an identical command varies. The full table lives in the skill's own `skills/backlog-orchestrate/references/rationale.md`, §2.

_(2026-09-04 note: the skill has since dropped the `-C "$PWD"` clause from both this command and the merge-mode probe (SKILL.md §2) — a no-op removed, since the
session's cwd was already the project root at every call site. Claude Code's `permissions.allow` grammar matches an entry against the literal command line by
prefix, so `Bash(git merge:*)` — the very rule the dashboard staged above — would not actually have matched the line quoted above; it starts `git -C`, not
`git merge`. Dropping the clause is what makes that rule genuinely cover the command SKILL.md issues today. The quote itself is left exactly as these three runs
issued it.)_

Two consequences, and together they are the whole feature: merging is a _choice_ (a run that stops at four reviewed branches is a successful run), and a run
that wanted to merge and was refused _degrades to that outcome_ rather than parking work that is perfectly good.

The setting is chosen in a browser and consumed by a headless process on the machine, so it cannot travel by `localStorage`, and the run file already has
exactly one writer. It rides the one channel that exists — the spawn prompt — and lands in the run file, where every other fact about a run lives:
`orchestrateDefaultMergeMode` (client Settings, per-device, default `'merge'`, clamped by the same `pickOne` as `dispatchDefaultModel`) seeds the
`OrchestrateSheet` picker; the sheet sends `mergeMode` on **every** launch, including when it equals the default, because the field is the sheet's answer to
"what should this run do" and inferring it server-side from an absent field would put one decision in two places; `AgentsService` validates it and appends the
compile-time literal ` --merge-mode branch`; `orchestrate.mjs init` writes `mergeMode`, `mergeModeEffective` and `mergeModeNote`.

The service's rule differs deliberately from every neighbouring field. Absent (`undefined` or `''`) resolves to `'merge'`; a member of `MERGE_MODES` passes
through; **anything else is a 400, uncoded — not clamped, not dropped.** `model` and `effort` drop an unknown value because dropping one costs a default model.
Dropping an unrecognised `mergeMode` would resolve to `'merge'`, and _merging to `main` is the irreversible direction_: a caller bug must not be able to pick
it. Absent still means `'merge'` because absent is not a bug — it is every request written before this field existed. Uncoded because `RUN_IN_PROGRESS_CODE`
stays the one machine-readable answer this endpoint gives, and nothing about a malformed enum needs telling apart from another 4xx.

`MergeMode` (`shared/types.ts`) is `merge | branch`, with `isMergeMode` as its one guard for the reason `isAgentAction` has one.

Two run fields rather than one, because the archive has to answer "did this run merge, and was that the plan?" months later. `mergeMode` is what was asked for
and is never rewritten; `mergeModeEffective` is what the run is actually doing and only ever moves `merge` → `branch`, never back; `mergeModeNote` says why they
differ. Collapsing them loses the distinction between a run that chose branches and a run that was denied them — exactly the distinction the post-mortem above
needed.

Enforcement of the mode lives in the tool, not in prose. `stage <id> merged` exits `1` and writes nothing when `mergeModeEffective` is `'branch'`, naming the
stage it should have used. `SKILL.md` has to survive several hundred turns of one session re-reading its own body; a tool refusal does not drift. The converse
is deliberately not enforced — `stage <id> branched` stays legal under `merge` mode, because that is precisely what a denied merge degrades an item to.

`SKILL.md` is re-read on every one of a run's several hundred turns and prose drifts across them; a tool refusal does not, which is the same division of labour
`buildGatedQueue` and its rationale already keep.

## `merged` is not the only success exit — `branched` is its branch-mode sibling

`branched` occupies the same terminal position `merged` does: `StageTrack` stays seven nodes and the seventh carries whichever word this item actually reached.
It is a true exit — the run is finished with the item and holds nothing — so it is out of `RUN_CLAIMED_STAGES` and out of `ATTENTION_RUN_STAGES` (a clean branch
needs nobody), out of `MACHINE_STAGES` (a terminal arrival opens no span, the same rule "queue wait is not work" already applies to `pending`), in
`RECONCILE_TERMINAL_STAGES`, and counted as completed by `aggregateRuns` alongside `merged`.

The cheaper option was to reuse `merged` and relabel it in the UI from the run's mode — roughly half the work, and a stored history that states an item merged
when `main` never received it. This repo has repeatedly paid for honesty in derived state over cheapness (`itemDurationMs`, `lastTouched`, `isStale`), and a run
archive that lies about what reached `main` is worse than a mechanical sweep across the classification sites.

What keeps that sweep from being a checklist someone forgets is `test/agents-shared.test.ts`'s `Record<RunStage, true>` literal: the compiler demands an entry
for every union member, and the test then forces each member into one side of both partitions. The one place the mode alone is not enough is `stepperDots`'
terminal word — an item that has already reached one of the two success exits answers with its **own** stage, and only an item still in flight falls back to the
run's `mergeModeEffective`, because a run downgraded at item 3 must not redraw items 1 and 2 as having branched when they merged.

Not every `branched` stamp was written by the run that did the work. `SKILL.md` §3's "Recognise a leftover branched item" step, run before pre-flight on every
item, can find a branch a _previous_ run finished and left waiting on a hand-merge, confirm it with an archive-move probe
(`git diff --name-only <base>...backlog/<id> | grep -q "/done/<id>-"`), and stage it `branched` in the **current** run's own file without ever dispatching,
reviewing or verifying it. This is deliberate — re-running that pipeline over already-green work would spend a whole item's budget re-proving what a prior run
already proved — but it does mean a `branched` entry in a run's history is not proof that run executed the item, only that it correctly recognised the item was
already done.

## A classifier denial degrades the run; every other merge failure parks

The degrade is narrow on purpose. When the merge is refused by the classifier the item is staged `branched` (not `parked`), the run records the downgrade once
with `merge-mode branch --note "auto mode classifier denied the merge of <id>"` — or `"auto mode classifier denied the merge probe"` when §2's pre-flight probe
is what was refused — so the rest of the queue skips a merge just shown to fail, and the run continues to the next item.

**That note is fixed text naming which of the two sites asked, not the classifier's own message** (bug-31). The denial's second half is a free-text `Reason:`
written by a model, and §4's rule — prose this run did not compose never rides a shell command line — reaches a `--note` value exactly as it reaches a prompt.
What `mergeModeNote` has to answer is "why is this run in branch mode", and which call was refused is the whole of that answer; the `Reason:` text itself stays
in the driver's own transcript beside the command that provoked it. `orchestrate.test.mjs`'s `every --detail and --note value is the driver's own words` reads
this file too, so the two copies of the command cannot drift apart again — which is how they drifted in the first place.

`parked` is wrong here, and correcting it is what this whole feature exists for. Parked means a human must look at the work. Nothing is wrong with the work —
every step before the last was green, and the last step of the pipeline was refused. Four green branches reported as four parks is what made the 2026-09-03 run
read as a failure.

**No attention entry, and no fourth attention kind.** `ATTENTION_KINDS` stays the closed set of three (`needs-answers`, `parked`, `fix-exhausted`): the
attention list means "a human must look at _this item_", and a verified branch does not qualify. The cause is one run-level fact recorded once in
`mergeModeNote`; N items denied by one classifier verdict would write N identical rows. The actionable part — the literal `git merge --no-ff backlog/<id>` per
branch, in merge order, with overlapping pairs flagged — belongs in the run's finish summary, where it is one list rather than N copies of one sentence.

**Every other §9 _merge_ failure keeps its behaviour exactly.** A conflict, a pre-merge refusal over overlapping dirty paths, a main tree not on `main` — all
still park, still keep the worktree, still say why. Those are genuine "a human must decide" states and none of them is a permission problem. The one §9 failure
that is not a merge failure — `git worktree remove` failing during the cleanup _after_ a green merge — splits in two on git's own message (bug-32) and only half
of it parks: `contains modified or untracked files` parks, because something in there was never committed; `failed to delete` does not, because git's clean
check already passed and the run simply finishes a delete git left half-done. SKILL.md §9's removal branch is that rule's one home.

The preflight probe in `SKILL.md` §2 — `git merge --no-ff --no-edit HEAD`, once per run, merge mode only — is early warning for the same failure and never a
guarantee. Merging `HEAD` into itself prints `Already up to date.` and changes nothing that matters (no commit, no index change, no reflog entry, dirty tree or
clean — it does refresh `.git/ORIG_HEAD`, the same as any other `git merge`, harmlessly), and the command _shape_ is byte-identical to the real merge so the
classifier is shown what it will be shown later. It buys "find out in ten seconds instead of four hours" and nothing else: the verdict is per call, so a passing
probe can still be followed by a denied merge, which is exactly why the degrade path exists as well as the probe.

## Question mode is run-scoped, and it only ever takes effect in a headless run

Question mode is run-scoped, and it only ever takes effect in a headless run. `QuestionMode` (`shared/types.ts`) is `decide | park`, with `isQuestionMode` as
its one guard for the reason `isMergeMode` has one, and it travels the exact route `mergeMode` does: Settings seed (`orchestrateDefaultQuestionMode`, default
`park`) → sheet → the spawn prompt's compile-time ` --question-mode decide` → `init` → one `run.json` field.

**`park` is the default and appends nothing**, so a default run's prompt stays byte-identical to what shipped before the field existed — inverted from merge
mode's silent `merge` and following the same rule, that whichever value is the default appends nothing.

**Absent means `park`; present-but-invalid is a 400, never a clamp**, for `mergeMode`'s reason restated in this field's terms: the value is written verbatim
into `run.json` and read out of the archive months later, so a typo resolving to the default would put a claim there that no caller made.

**One field, not three** — nothing degrades or promotes a question mode mid-run the way a denied merge moves `merge` → `branch`, so a `questionModeEffective`
would record a divergence that cannot occur.

The two modes are **identical whenever `AskUserQuestion` is reachable**: the ask itself (SKILL.md §3, once, best-effort) is unchanged in both, and the mode
governs only the unanswered branch — which gives the feature its one doctrine, repeated in the Settings hint, the sheet's hint, SKILL.md §3 and here: want
control over a question, start the run from a harness that has `AskUserQuestion`; start it from the board and you are choosing between skipping the item and
letting the runner answer.

What a `decide` run settled is recorded by `orchestrate.mjs assume <id> --json <file>`, the one writer of `RunQueueItem.assumptions`, appending rather than
replacing, and **the tool refuses it under `park`** — exit `1`, run file byte-identical — the same division of labour `stage <id> merged` under branch mode
keeps, because SKILL.md is re-read on every one of a run's several hundred turns and prose drifts where a tool refusal does not. The converse is deliberately
not enforced: `attention --kind needs-answers` stays legal under `decide`, because `decide` is permission to answer and not an obligation to invent.

**No fourth `ATTENTION_KIND`** — that list stays the closed set of three and means "a human must look at this item", which a decided-and-merged item does not
warrant; the same precedent a classifier denial already set, one section above.

## `orchestrate.mjs` is always invoked from the project root, never from inside a per-item worktree

`resolveProjectRoot()` walks up from `process.cwd()` looking for a `.git` entry, deliberately duplicating rather than importing `backlog.mjs`'s identical walk
(the file's own header comment gives the standalone reason). Every command but `init` uses this instead of a `--project` flag to decide which project's run file
it means, because every one of them (`stage`, `heartbeat`, `attention`, `finish`, `status`, `watch`, `abort`) is only ever invoked by the orchestrator loop
itself, whose own cwd is the project root for the run's entire lifetime; `init` is the exception because it can plausibly run from somewhere else — a server
endpoint spawning the orchestrator before its child process has even changed directory.

The contract used to be enforced by prose alone, and bug-2 is the record of why that was not enough. A linked worktree carries its own `.git` (a file, not a
directory, pointing at the shared gitdir), so the old `existsSync` test — which cannot tell a file from a directory — found it immediately and resolved the
WORKTREE's own path as "the project" instead of erroring. The run was then keyed under `encodeURIComponent(<worktree path>)`, a directory nobody else ever
reads, while every other command and the server kept keying by the registered project's own path. Nothing crashed and nothing was corrupted; the run simply
appeared to vanish, reported as exit `3`, "no run exists" — the same code an unattended loop reads as "nothing to do." A prose rule can only bind the commands
the prose knows about, and the trap was armed by anything at all that left the shell inside a worktree: the run that surfaced it was broken by a one-off
`pnpm exec jest --version` probe.

`resolveProjectRoot` now refuses instead, and so does `init` over its validated `--project` value (the one command that never walks up from cwd, and therefore
the same hole from the other side). Exit `1` — a problem with this call, nothing written — deliberately not `3`, which is the exact conflation the bug was
about. The discriminator is not "`.git` is a file": it is whether the `gitdir:` target contains a `commondir` entry. A worktree gitdir has one, a submodule
gitdir does not, so a submodule working tree still resolves to itself as it always did. The refusal names both the worktree and the project root to re-run from,
derived from those same two files without shelling out to git, and degrades to naming the worktree and its gitdir when the main tree cannot be determined (a
bare main repo).

The invariant itself is unchanged — it just crashes loudly now instead of answering wrongly. The per-item worktree and branch a command needs are still passed
as explicit values (`stage --worktree <path> --branch <name>`, `verify --cwd <dir>`), never implied by cwd, and those flags are deliberately exempt from the
check: they name a worktree on purpose.

## A `runner-fix:` item is hoisted to the front of the queue, and the marker is read at `<base>`

The failure this exists for is recorded in idea-5: run `run-20260901-112035` queued a permission-flag fix as item 3 of 5, and item 1's very first dispatch was
refused by exactly the flag item 3 existed to replace. The natural ordering — bugs then tasks, oldest first — cannot see the one property that mattered: _this
item repairs the thing that is about to execute the rest of the queue_. A human marks it (`runner-fix:` in the item's frontmatter), `buildGatedQueue` hoists it,
`plan` prints `(runner fix — hoisted)` on the row. Marking is a judgement; hoisting is mechanical.

**No path heuristic.** The mechanical option — `## Affects` or `## Fix` naming `skills/`, `agents/`, `server/src/agents/` — was considered and rejected on its
own terms: most `skills/` edits do not affect a running orchestrator, and a dispatch-route fix that does affect one need not name any of those paths.
`backlog-groom`'s SKILL.md asks the question in both verdicts that produce an executable item, naming the exact key spelling.

**Presence hoists; only `false` opts out.** `runner-fix: true`, `runner-fix: yes` and a bare `runner-fix:` all hoist. A key that hoisted on the literal `true`
alone would let `runner-fix: yes` silently not hoist — a queue in the wrong order with nobody told, which is the exact failure class the marker exists to
remove. `false` is honoured because "considered, and it is not a runner fix" is worth being able to write down; the compare is case-insensitive, since `False`
is the same YAML boolean and reading it as "hoist" would be the mistake in the direction that actually reorders a run.

Two halves a future reader will otherwise undo:

- **The marker is read at `<base>`, not off the working copy.** It is parsed inside `parseItemForGate`, the one function both `readItemForGate` and the
  `git show <base>:<path>` blob path funnel through, so an item's marker always comes off the same bytes its gate verdict did. Identical rule to the gate's own,
  for the identical reason: the worktree this run creates from `<base>` would not contain a marker that only exists on disk. The `committed === null` branch
  (item absent from `<base>`) reports **not hoisted** even though it reads its _title_ off the working copy — a title labels a row that prints either way, a
  marker moves other items.
- **`--ids` is hoisted too**, deliberately narrowing SKILL.md §1's old "in the order given". `OrchestrateSheet` sends `ids` for any strict subset of its
  checkbox list, so that list is a _selection_, not an ordering — nobody chose the order it arrives in, and exempting `--ids` would defeat the hoist on the one
  surface CLAUDE.md tells you to start runs from. It is also what makes a client change unnecessary: no new typed field on `BacklogItem`, no server-side parse,
  no badge, to restate a decision the tool already makes correctly for every launch path.

  task-20 gave the sheet a step 2 that _does_ choose the order, and the rule is unchanged by it: a runner fix still hoists above a hand order. The reasoning
  simply moves off "nobody chose this" and onto what the hoist is for — executing that item repairs machinery the rest of the run depends on, which is true no
  matter who arranged the queue or in what sequence. What the sheet owes a person who has just arranged one is a _warning_, and step 2 carries it: a
  `runner-fix:` item may still jump the line, and this screen deliberately cannot say which one, because the preview is client-side off `BacklogItem` (no
  `runnerFix` field) while the marker's authority is the blob at `<base>` — a derived badge would be confidently wrong for an item marked but not yet committed.

The partition is stable and outranks the section ordering rather than sorting inside it: hoisted items keep bugs-before-tasks and oldest-first among themselves,
the rest keep the order they had, and a marked _task_ hoists ahead of an unmarked bug. It runs before `--max` is counted, which is most of the point — a runner
fix that was going to fall outside the cap now lands inside it. The gate itself is untouched, so an ungroomed marked item hoists too and prints first labelled
`ungroomed`; "the thing that would fix your runner is not groomed" is information, and the top of the list is where it gets read.

**Ordering alone would buy nothing.** Every skill body and every `orchestrate.mjs` invocation in a run resolves through `$CLAUDE_PLUGIN_ROOT` — the installed
plugin copy — while the merge lands in this repo's `main`, so a merged fix does not reach the run that merged it. SKILL.md §9's "After a runner-fix item lands"
is the within-run half: print `git diff --name-only HEAD^1 HEAD` **in the base tree** (bug-38 — `HEAD` there has to mean the merge commit, and on a `--base` run
the project root's is `main`), and if it names `skills/backlog-orchestrate/SKILL.md`, follow the repo's copy for the rest of the run — plus the repo's
`orchestrate.mjs` if that moved too. **Prose and tool move together or not at all**: following freshly merged prose while still
invoking the installed tool is the one genuinely dangerous combination, because the new body may name a flag the old tool refuses.

The switch is session state and nothing on disk carries it, so a crashed run resumed by the board or the watchdog is handed the installed copy again. Both
halves revert together, so nothing becomes _inconsistent_ — what lapses, silently, is the whole point of the marker, at the one moment a broken runner makes a
crash most likely. The durable record is the note the run already writes
(`stage <id> merged --note "runner fix — the remainder of this run follows the repo copy"`), and `references/recovery.md`'s `--resume` procedure re-derives the
switch from it before the first item is taken over. A note rather than a new run-file field, and no `attention` entry: `ATTENTION_KINDS` stays the closed set of
three and means "a human must look at this item", which a run that successfully picked up its own fix does not warrant. None of this substitutes for the sync —
a merged runner fix is inert for the _next_ run until HEAD is pushed and `pnpm run plugin:sync` has run.

## `agents/` is part of the plugin's publish surface

Claude Code discovers a plugin's agents by the same directory convention it uses for skills: every `*.md` in the plugin root's `agents/` directory becomes an
agent named by its own `name:` frontmatter key, addressed as `<plugin>:<name>` — no declaration in `.claude-plugin/plugin.json` required (confirmed against a
second installed plugin, `caveman`, which ships three agents with no `agents` key anywhere in its own `plugin.json`, and all three load and are dispatchable).
But an install is a copy of exactly two things: whatever `PUBLISHED_PATHS` (`scripts/sync-plugin.mjs`) tells `plugin:sync` to check for dirty/unpushed state and
copy, and whatever the marketplace's own sparse checkout on the installing machine actually pulled down, declared as `sparsePaths` in that machine's
`~/.claude/settings.json` under `extraKnownMarketplaces.<marketplace>.source`. Sparse cone mode carries root-level _files_ automatically but only the
_directories_ explicitly listed, so a root-level `agents/` reached neither list until this task — `backlog-manager:backlog-reviewer`
(`agents/backlog-reviewer.md`) could sit committed and pushed in the repo and still not exist in anyone's installed copy. Both halves have to be true together:
`PUBLISHED_PATHS` without a matching `sparsePaths` entry means the checkout never fetches the directory for `PUBLISHED_PATHS`'s own dirty-check to find;
`sparsePaths` without `agents` in `PUBLISHED_PATHS` means the directory is on disk but `plugin:sync`'s hash/dirty logic never accounts for it. `sparsePaths` is
machine state, one per install, and outside this repo's control — the repo can only ever carry its own half of this invariant.

Which file holds that machine state is not a detail, and bug-10 is the record of getting it wrong twice over. `~/.claude/plugins/known_marketplaces.json` looks
like the control and is only a cache: Claude Code reconciles it from the `extraKnownMarketplaces` declaration in `settings.json` on session start,
deep-comparing the declared `source` object against the materialized one and re-running `git sparse-checkout set --cone -- <declared paths>` in the marketplace
clone on any difference at all. So an `agents` added to the cache by hand survives until the next session start _and is itself what triggers the revert_ — the
edit is the difference the reconciler resolves in the declaration's favour. An install made in that window carries the agent while the clone behind it no longer
does, which is exactly the state this machine was found in on 2026-09-02.

The other half of bug-10 was the sync's own blindness to all of it. `plugin:sync` short-circuited on `hashTree('skills')` alone against a matching
`gitCommitSha`, so an install whose sparse checkout had never written `agents/` was byte-for-byte indistinguishable from a complete one — and the short-circuit
fired forever, because the one path it measured never moved. `gitCommitSha` cannot cover for that: it records which commit the install was cloned from, not
which paths were written out of it, and the same sha legitimately yields an install with `agents/` or without. The sync now digests every entry of
`PUBLISHED_PATHS` on both sides (`publishedDigests`/`driftedPaths`, exported and unit-tested), relies on `hashTree`'s existing `''`-for-a-missing-root to make
an absent path read as drift rather than adding a second existence check to keep in sync, names the paths it compared in both the in-sync and the reinstalling
message, and re-checks the same list after the reinstall. That last check is the load-bearing one: an install that completes and _still_ has nothing at a
published path is the sparse-checkout shortfall by elimination, so it exits non-zero naming the settings key to edit. A read-only pre-flight warning reads the
declaration it can see and names any published path missing from it — warn, never refuse, because the declaration legitimately lives at any settings tier or in
`marketplace add --sparse`, and a machine declaring no `sparsePaths` at all clones the whole repo and is perfectly correct. It runs before the uninstall so the
actionable line is not buried under install output, and it can never abort in the window between the uninstall and the install, which is the one that would
leave a machine with no plugin.

## `started:` and `phase:` are the lifecycle keys in frontmatter, and neither is a status

The `status:` ban stands (both parsers still throw on it), unaffected by either of these keys — a second answer to "which directory holds this file" is the
competing source of truth the ban exists to prevent, and neither lifecycle key answers that question. `started` answers a different one — is someone on this
right now — and an item carrying it is still an open item in `<section>/open/`. `phase` answers a narrower, shorter-lived question on top of that: _which_
activity currently holds the `started:` marker, `groom` or `execute`. It has no meaning and no lifespan of its own — it is written alongside `started:` only
when `start` is called with `--as`, and `stop` always removes it, in the same call that decides what happens to `started:`. That one-way coupling is deliberate,
not an oversight: a `phase` that could outlive its `started:` as a live marker, or go stale independently of it, would be a second axis an item's "where is it
in its lifecycle" depended on — exactly the ambiguity the `status:` ban already exists to close off, reopened one key over. It was a _two_-way coupling —
`phase:` and `started:` removed together, never separately — until Task 7's `stop --keep-started` deliberately broke the other direction: it removes `phase:`
same as any stop, but leaves `started:` behind, because at that point `started:` has already stopped being a live marker and become the archived item's record
of when work began — a `phase:` still naming an activity would misdescribe finished work as ongoing, so it is exactly the value that must not survive, while
`started:` surviving is the whole point. `stop` never takes an `--as` of its own for this reason — it reads `phase:` back off the file instead, the one place
that can't disagree with itself. Surfaced raw by the scanner; "in progress" is `started !== '' && status === 'open'`, decided in the client, because archiving
deliberately keeps the value as history (see below).

`start`/`stop` are still the only two commands that rewrite an existing item's content — `move` renames and never opens the file — so both must round-trip
unknown keys and the body byte-for-byte, and both stamp `updated:` while doing it, inside `writeItemFile`, the one function they both funnel through rather than
each writing that line itself (a caller added later can't forget a convention it never has to know about). `move` is deliberately excluded from that stamp —
opening a file just to change one line would reintroduce the exact risk the plain `renameSync` exists to avoid. Every skill path that moves an item calls `stop`
immediately beforehand — `backlog-groom`'s moves (an idea promoted to `done/`, anything rejected to `out-of-scope/`), `backlog-execute`'s abandonment path, and
now `backlog-execute`'s own successful archive too (see the next paragraph) — so `updated:` is never more than one function call older than the move that
follows it, for every path there is.

Two skills call `start`/`stop`, holding the marker for different spans, and `backlog-execute` now calls two different shapes of `stop`. `backlog-groom` holds
the marker for one groom session — `start --as groom` once the item and the verdict are both confirmed, `stop` again once that verdict's steps finish, or as
soon as the session ends without a verdict at all, so an abandoned groom never leaves a stamp nothing will clear — billing whatever elapsed into
`groom-elapsed:` every time it does. `backlog-execute` picks an item up with `start --as execute` and holds the marker until the work is either parked or
archived. Walking away without archiving calls plain `stop`: it bills the session into `execute-elapsed:` and clears `started:` along with `phase:`, because
nobody is working the item anymore and there is nothing left to date. Archiving instead calls `stop --keep-started`: it bills the same way and still drops
`phase:`, but leaves `started:` in place, because a `move ... done` is about to follow and the archived item should still record _when the work began_, not
merely _that_ it did — the same historical value a bare `started:` has always carried for this skill, now sitting alongside the elapsed total instead of
standing in for it. Either skill can stamp an idea now: the original reasoning for refusing one — "an idea has nothing to execute" — held for execute but not
for groom, since deciding an idea's verdict is itself the active work the marker exists to describe. None of this widens who writes the file: `backlog.mjs` is
still the single writer, `start`/`stop` are still the only two commands that touch an existing item's content, and the round-trip guarantee above covers both
callers identically.

`groom-elapsed:` and `execute-elapsed:` are permanent, accumulating integer counters — one whole-seconds total per activity, never reset, growing by one more
`stop`'s worth each time that activity picks the item back up again. `stop` only adds to a bucket when the item has a recognized `phase:` (nothing to bill
against otherwise — a plain `start` with no `--as` leaves both `started:` and every bucket alone) and when `started:` is the full second-precision timestamp
shape, never the legacy bare date: UTC midnight is not the hour anyone began work, so treating a bare date as billable would fabricate up to 24 hours nobody
worked — the marker is still cleared, just never billed. The seconds added are floored at zero, to cover clock skew between whatever machine wrote `started:`
and whatever machine is now calling `stop`: two machines a few seconds apart must never bill negative time just because the second one's clock reads slightly
behind the first's. And a bucket that already holds something other than a plain unsigned integer — a hand-edit, or a value some older, buggier build left
behind — makes `stop` refuse outright rather than reset it to zero: resetting would silently destroy whatever real total was recorded there, and a refusal at
least leaves the bad value in the file for a human to recover by hand.

`groom-tokens:` and `execute-tokens:` are the token-shaped siblings of those two, and everything in the paragraph above applies to them unchanged: same
accumulation, same permanence, same DIGITS_ONLY refusal on a corrupt bucket. There are four counters now, two per activity — elapsed time says how long an item
took, tokens say roughly how much model work it took, and neither implies the other: a session can idle for an hour or burn a million tokens in ten minutes.
Deliberately ONE gate covers both, not two: the token window _is_ the interval the seconds are computed from, so if that interval is not billable then neither
is the window over it, and `--abandon`, a phase-less `start` and a legacy bare date each fall out billing nothing without a second rule being written for them.

The count comes from the calling session's own transcript, which it names itself: `CLAUDE_CODE_SESSION_ID` is present in the environment of every Bash tool call
and the transcript is flushed mid-session rather than at exit (measured, on a live session: 317,222 bytes and 14 completed turns on disk while it was still
running), so a `stop` running inside the session it is measuring can read that session's own history. There is therefore **no hook** and nothing added to
`PUBLISHED_PATHS`. The main transcript is found by scanning project directories for `<sessionId>.jsonl`, never by deriving the directory from cwd — the slug
rule is undocumented, and a `backlog-execute` session's cwd is inside a per-item worktree whose slug is not the main tree's anyway. Subagent turns are NOT in
that file: they live in a sibling `<sessionId>/subagents/agent-*.jsonl` and are summed too, because a run of this repo's own history spent ~2M tokens on
reviewer subagents and a number excluding them would be worse than no number.

Three rules inside the count, each an answer rather than an omission. **Dedupe on `requestId`** (falling back to `uuid`): one API turn is written as one record
per content block — thinking, text, tool_use — each repeating the same `usage` object verbatim, so a naive per-record sum inflates a typical turn 2-3x, and the
inflated number still looks entirely plausible in isolation. Measured, 25 of 28 turns in one transcript were split this way. **Cache reads are excluded** — the
number is `input + cache_creation + output`. Measured on one live session, fresh 89,210 against cache_read 804,246: a raw total is ~90% re-read context floor,
which scales with turn count and prompt size and is close to identical for a trivial item and a hard one, so it would swamp the signal the number exists to
carry. Cache _creation_ stays in as material genuinely pulled into context; output stays in as the model's own work. (`output_tokens_details.thinking_tokens` is
a subset of `output_tokens` and `usage.iterations[]` is a breakdown of the top-level fields — adding either double-counts.) **The window's upper bound covers
the whole second the stamp names**, because both stamps truncate to the second while records carry milliseconds — otherwise the turn that issued the `stop` call
itself, landing at `:50.900Z` against a stamp of `:50Z`, would fall outside its own window.

Attribution is whole-session-within-the-window, not per-item, and that is stated rather than fixed because there is no tighter mechanism available: nothing in a
transcript marks a turn as being about item X, so `start`/`stop` is already the finest bracket that exists. Under `backlog-orchestrate` it is very nearly exact
— each item gets its own headless `backlog-execute` session, so the window covers that session and nothing else, and that is the consumer that matters since it
is where the expensive items are. For hand grooming in a shared terminal it is noisy by exactly as much as the unrelated work in the window. Treat it as a rough
complexity signal: right for "which items were expensive", wrong for anything claiming precision. Do not invent a heuristic to narrow it.

A count that cannot be attributed at all — no session id in the environment, no transcript matching it, a file that cannot be read — writes **no key**, not `0`:
`0` claims the work was tiny, which is a different fact. It is never fatal (the stop still exits 0, and the seconds it did bill are unaffected) but it is never
silent either — one stderr line names what was missing, the same non-fatal note pattern `registryRoot` uses for a registration it could not make. That note was
built because every measurement behind this feature came from a headless `sdk-cli` session, so the first non-headless `stop` would either record a number or say
out loud why it could not.

It recorded a number. Measured 2026-09-05 in a session whose `CLAUDE_CODE_ENTRYPOINT` is `claude-desktop`, through the installed plugin copy rather than the
working tree: a `start --as groom` / `stop` pair on task-11 billed `groom-elapsed: 43` and `groom-tokens: 6527`, with no stderr note. So
`CLAUDE_CODE_SESSION_ID` is not `-p`-only, and the mid-session transcript flush the whole mechanism rests on holds outside a headless run too. An independent
counter over that same 43-second window found 6 records under 3 request ids: deduped `6527` — exactly what the CLI wrote — against a naive per-record sum of
`13054` and a `cache_read_input_tokens` of `676452`. That last figure restates the cache-read exclusion for a desktop session carrying a large resident context,
and it runs the same way as the original 9:1 headless measurement only harder — roughly 104x the billed number. The exclusion matters more in an interactive
session, not less. The terminal TUI (`CLAUDE_CODE_ENTRYPOINT=cli`) is still unmeasured; the entrypoint is set by the harness rather than the skill, and the
stderr note remains the answer for any environment that turns out to lack the variable.

The `started:` value is a second-precision UTC timestamp (`2026-08-28T14:03:07Z`), not a date, because the useful resolution for "is anyone on this right now"
is minutes and hours: a bare date rounded everything picked up today to `0d`, which is precisely the work the marker exists to surface, and read as "nothing has
happened yet". UTC because the value is compared against `Date.now()` on whatever machine renders the board.

Both timestamp shapes are on disk permanently. Every file stamped before `phase:` and elapsed billing existed carries a bare `YYYY-MM-DD`, and no command
rewrites an existing item's frontmatter on its own initiative — so this is not a migration window that closes, and a reader that drops the date-only branch
breaks real files. A bare date is aged in DAYS ONLY (`today`, then `Nd`): UTC midnight is not the hour anyone started work, so reading `14h` off `2026-08-26`
would be inventing it. `elapsedSince` in `client/src/lib/item-age.ts` is the one implementation of both branches.

## `refactors/` is a peer section, not a facet on ideas

`refactors/` is a peer section, not a facet on ideas: ideas are new, refactors are existing things that should be improved. Prefix `ref` (short because the
card's meta line is ~118px of nowrap), lifecycle identical to ideas (`open/` → `done/`, promotable to a task with `from:`, rejectable).

`kind: chore | debt` is written by `backlog-capture`, round-tripped by the CLI as an unknown key, passed through verbatim by the API, and badged by the client
only for the values `REFACTOR_KINDS` lists.

`backlog-execute` refuses the section outright — its refusal gate inspects only a task's `## Plan` and a bug's `## Fix`, so an id from any other section has to
be turned away by the directory check that runs before it.

## Editing `skills/` changes nothing until commit + push + `plugin:sync`

A plugin install is a copy, not a link: Claude Code loads `~/.claude/plugins/cache/backlog-manager-marketplace/backlog-manager/<version>/`, never the working
tree. The drift is silent — `started` shipped in `fcd3d16` and the installed plugin sat on the first commit for weeks. The marketplace source is the private
repo `futin/backlog-manager` over SSH, sparse-checked-out to `.claude-plugin skills`, which is why an install is ~400KB instead of the ~215MB a `directory`
source copied (`node_modules` and `dist` included — the CLI honours no ignore file; checked against 2.1.246, and it rejects a `file://` source, so a local-only
git source is not on the table). Git is therefore the publishing boundary: the installer sees pushed commits and nothing else, so `plugin:sync` refuses a dirty
`skills/`, an unpushed HEAD, or a HEAD behind `origin/main` rather than installing stale code and reporting success. It never commits or pushes for you. It also
uninstalls and reinstalls rather than calling `claude plugin update`: that command compares the version in `plugin.json` and stops at "already at the latest
version" however far the commit behind it has moved, and the cache directory is keyed by version, so the alternative would be a patch bump — another commit,
another push — on every skills edit. A reinstall from a sparse source is cheap enough that the bump buys nothing. It no-ops when the installed copy already
matches HEAD, verifies the landed `skills/` by hash, and prunes older version copies — skipping any marked `.in_use`, which a running session still has open.
New skills load on the next Claude Code restart, not in the session that ran the sync.

## `pnpm test` is the union of both runners

`pnpm test` is the union of BOTH runners — `scripts/test-all.mjs` runs `test:jest` and then `test:skills`, always both, and exits `1` if either failed. Do not
"simplify" `test` back to bare jest: jest's `testMatch` is `test/**/*.test.ts(x)` and can never reach `skills/*/tools/*.test.mjs`, so for a long time the one
word everything reaches for — a human, an orchestrated item's verification step (`resolveVerifyCommands` resolves to `['test','typecheck','build']` off
`package.json`), any future CI — proved nothing at all about `orchestrate.mjs` (the run file's only writer) or `backlog.mjs` (the registry's only writer) — the
whole of this repo's single-writer tooling (`wc -l skills/*/tools/*.mjs` prints how much), which could regress past every automated gate this repo has and merge
to `main`.

`backlog/verify.json` was the rejected alternative: it closes the orchestrated-merge half and leaves a human's `pnpm test` false-green, and the human half is
what the 2026-09-06 audit found.

The price, measured on a clean tree 2026-09-07: ~143s instead of jest's ~60s, so roughly +83s on every orchestrated item's verification step, paid knowingly.
(Grooming predicted ~210s against a 136s jest baseline, i.e. +54%; both absolute figures were taken on a loaded machine and came down, while the ratio went the
other way — +138%, because a free machine speeds jest up far more than it speeds the node runner up. The absolute number is what a run actually pays.)

The two named scripts stay the single copy of what each runner runs — `test-all.mjs` delegates to them and never re-spells `test:skills`'s glob pair, whose
`scripts/*.test.mjs` half is the one most easily lost. Neither runner short-circuits the other, because a run with both broken has to report both.

The script has no test of its own on purpose: `scripts/test-all.test.mjs` would match `test:skills`'s own glob and spawn the whole suite from inside the suite.

## A supertest suite listens once, on `127.0.0.1`, through `listenLoopback`

bug-33. A full `pnpm test` occasionally reported **exactly one** failed test out of ~1500, always a supertest assertion, always green on the very next run of
the same command against the same tree, and never in a diff that touched server code at all.

That is a merge-gate defect, not a cosmetic one. `backlog-orchestrate` §8 makes the exit code of `pnpm test` the only thing that green-lights a merge, and
"never merges red" is a Hard limit with no unrelated-looking-failure escape hatch. A one-in-N false red either parks a green, reviewed item or — worse — teaches
whoever drives the run to re-run the gate until it passes, which is the habit that would let a real regression through.

**The mechanism.** supertest builds its URL in `serverAddress()` (`node_modules/supertest/lib/test.js`, 7.2.2):

```js
if (!addr) this._server = app.listen(0); // binds `::` — no host argument
const port = app.address().port;
return protocol + '://127.0.0.1:' + port + path; // dials IPv4 loopback — hardcoded
```

Those two lines do not agree. `listen(0)` with no host binds the IPv6 wildcard `::`, and the kernel draws the ephemeral port against that address alone — a
socket some other process already holds on `127.0.0.1:P` does not make `::P` unavailable. The dial then goes to `127.0.0.1:P` and is routed to the **most
specific** match: the stranger's socket, not ours. The request never reaches the app under test, and the assertion runs against whatever that other program
answered.

One mechanism, every observed surface error and no others: a non-HTTP listener gives `Parse Error: Expected HTTP/, RTSP/ or ICE/`; an HTTP listener gives a
status this app never returns for that route (the observed `expected 403, got 400` — read at the time as the body parser rejecting before `OriginGuard`, which
was a sound inference about a response this app never produced); a listener that accepts nothing gives `connect ETIMEDOUT`.

**Measured**, not inferred. A 20,000-iteration probe replaying supertest's pattern exactly, against this machine as it stood (40 loopback listeners, 4 of them
on `127.0.0.1` inside the ephemeral range — two `java`, Postman, WebStorm): 13 anomalies, ~1 in 1,540 — 8 wrong statuses, 2 parse errors, 3 connect timeouts.
The identical probe with the single change `listen(0, '127.0.0.1')`: zero. `test/supertest-bind.test.ts` reproduces the same thing deterministically in
milliseconds — a wildcard `listen(P)` succeeds on a port `127.0.0.1` already holds and reports `::`, the IPv4 dial to it comes back `HPE_INVALID_CONSTANT`, and
the same bind written with the host is refused `EADDRINUSE`.

Everything previously filed as inexplicable follows from it: exactly one failure per run (a few hundred draws at ~1 in 1,500), never reproducible (the colliding
port is a fresh draw, so re-running proves nothing about the tree), only ever the full suite (the draw count is the number of supertest requests in the
process), worse on a loaded machine (the rate is foreign `127.0.0.1` listeners in the ephemeral range over the size of that range — and all four sightings came
from `pnpm test` inside an orchestrator run, with a headless session, a verify suite and a dev server all holding ports), and untouched server code in every
triggering diff (the defect is in the harness's socket setup, not in anything under test).

**The rule.** `listenLoopback` (`test/helpers/app.ts`) is `app.listen(0, '127.0.0.1')` and is the only way a suite here puts an app on a socket. One helper
rather than an inline call in eighteen suites, because the host argument is the entire fix and eighteen copies are eighteen chances to drop it. A named host
cannot be shadowed: the kernel refuses it `EADDRINUSE` when the port is taken.

Listening once has a second effect that matters as much: with `app.address()` non-null, supertest's `if (!addr)` branch never runs, so it opens and closes
**nothing** per request. `orchestrator-runs.test.ts` had already blamed that per-request churn for a separate intermittent `socket hang up` (~1 run in 4) and
worked around it with a bare `await app.listen(0)` — half right, and the half it left in place is exactly the wildcard bind above. Every `await app.close()`
stays where it is; it now tears down a real listener, and it is the only thing that does.

**Not `jest.retryTimes`.** A retry hides a real regression exactly as well as it hides this one, and the gate's whole value is that red means red.

**`watchdog-sweep.test.ts` is the one exception and must stay one.** Its `createApp()` runs inside each case, and five cases call `jest.useFakeTimers()` before
it, so a real `listen()` awaited there could never settle. It takes `createApp({ listen: true })` and only the cases that hand the app to supertest — all under
real timers — pass it. Moving `jest.useFakeTimers()` after `createApp()` to avoid the parameter is not available: the watchdog arms its chain during `init()`,
and those cases exist to drive that chain from the fake clock.

**Pinned by source guard, because behaviour cannot reach it.** A suite that forgets the helper stays green roughly 1,499 runs in 1,500 — that is the defect
itself. So `test/supertest-bind.test.ts` reads every file under `test/` and asserts that each one importing supertest also calls `listenLoopback(`, and that a
bare `.listen(0)` appears nowhere at all, comments blanked first (the same precaution `server-bind.test.ts` takes, and for the same reason: several files quote
the bad spelling while explaining it). What the guard cannot catch, stated so a green is not over-read: a suite that builds a **second** app and listens only
the first. Two such pairs exist today (`csp`, `allowed-hosts`) and both listen every app they hand to `request(...)`.

**Left unproven deliberately:** a `pnpm test` that once printed `FAIL jest` over a jest summary reporting zero failures. It is consistent with this bug — a
crossed-over connection can fail after the test that made it has settled, making jest exit non-zero while attributing no failed test — but this fix removes the
only demonstrated source, and if it recurs it is a defect in `scripts/test-all.mjs`'s exit-code handling and earns its own bug rather than a guess recorded here
as fact.

## Loopback bind is the access control (except where noted)

Nothing in this stack has auth in front of it — the item-body route reads every registered project's backlog files straight off disk — so loopback is the access
control. `BM_BIND` is the single knob for the bind (`main.ts` and `vite.config.ts` read the same variable); `docker-compose.yml` sets it to `0.0.0.0` in both
services because there the loopback _publish_ is the boundary and a container-loopback bind would just hide the port. Reach it from another device with your own
`tailscale serve` in front of the loopback port, which is also what makes `allowedHosts: ['.ts.net']` in `vite.config.ts` meaningful — that list is never
consulted for a bare IP, so it protects nothing on a wildcard bind. With `BM_AGENTS` on, that bind is no longer standing in front of a read surface alone: it
also fronts a POST that spawns a Claude Code session with file-write permission in another repo. That is a boundary a browser inside the loopback does not
respect at all, which is exactly why the origin and content-type guard on those two routes exists — the bind and the guard cover different attackers, and
neither substitutes for the other.

**Both halves are pinned**, and asymmetrically for a reason: the dev server's bind is an ordinary import (`test/vite-proxy.test.ts`), while the API entrypoint's
is read out of `server/src/main.ts`'s SOURCE (`test/server-bind.test.ts`) because `main.ts` calls `bootstrap()` at top level with no `require.main` guard, so
importing it opens a real socket. The source test resolves the `.listen(...)` arguments through the consts they name and evaluates them against a fabricated
`process.env`, so it asserts what the expression computes rather than that a `127.0.0.1` string appears somewhere — and a bare `app.listen(PORT)`, the refactor
that silently binds the wildcard, fails it on the argument count.

What a bind does **not** cover is a name: see [Every route is gated by a Host allowlist](#every-route-is-gated-by-a-host-allowlist) below, where a page in this
machine's own browser walks straight through the boundary this section draws.

## Every route is gated by a Host allowlist

`isAllowedHost` and `allowedHostGate` (`server/src/allowed-hosts.ts`), and the attack they close is DNS rebinding — bug-22, the sole Critical of the 2026-09-06
audit.

The bind above draws a boundary around this machine. A browser on this machine is already inside it, which is the reasoning that produced
[the origin guard](#every-agents-post-is-guarded-by-content-type-and-origin). But that guard asks whether two headers **agree** —
`new URL(origin).host === req.headers.host` — and both of them belong to the attacking page. A page served from `evil.test`, whose DNS re-resolves to
`127.0.0.1` after the page loads, sends `Origin: http://evil.test:4322` and `Host: evil.test:4322`: a perfect match. Its `fetch` is genuinely same-origin as far
as the browser is concerned, so there is no preflight to withhold and `application/json` — the guard's other check — is sent for free. Two checks, one bypass,
and the request lands on `POST /api/agents/dispatch`, which forwards the attacker's prompt to the dashboard's `/api/spawn` at the dashboard's permission
ceiling.

An allowlist is the check that attack cannot pass, and the reason is structural rather than statistical: the browser derives `Host` from the URL the attacker's
own page was loaded from. They choose its value freely, but they cannot make it read `localhost` while the page's origin stays `evil.test` — the authority in
both headers is theirs by construction. "Do these two headers agree" is a question a rebound page always answers yes to; "is this a name this app answers to" is
one it always answers no to. The gate asserts an **identity**, where the guard asserts a _relation_.

**Global, not scoped to the agents POSTs.** The guard is route-scoped; the exposure is not. The same rebound page reaches every GET here — `/api/items/body`
reads any registered project's backlog file straight off disk, `/api/projects` and the orchestrator reader hand over absolute host paths and run state. That
read surface is precisely what the loopback bind exists to protect, so a fix scoped to the POST routes would have closed the session-spawning half and left the
original asset open to the same page.

**Registered by the same applier as the CSP**, host gate first (`applySecurityMiddleware`, `security.ts`). One applier, so no app built in this repo — the one
`main.ts` boots, the ones the suites build — can carry the CSP without also carrying the gate; and that applier already sits ahead of `ServeStaticModule`, which
the gate needs for the same reason the CSP does: serve-static streams `index.html` itself, so middleware behind it never runs for that request.
`test/allowed-hosts.test.ts` pins that ordering behaviourally — a rebound `GET /` comes back 403 without the page's bytes — rather than by reading source. The
applier was renamed from `applySecurityHeaders` when the gate landed, because it no longer only applies headers.

**What the list accepts, and why each entry cannot be rebound:**

- **Any IP literal** (`net.isIP`, with IPv6 brackets stripped — `new URL('http://[::1]:4322').hostname` is `'[::1]'`). An IP is not a name, so there is nothing
  to rebind: for a browser to send `Host: 203.0.113.5` to this socket, the packet would have to route to that address. This rule is also why every pre-existing
  suite stayed green with no header added to it — the request goes to an ephemeral port on loopback and carries `Host: 127.0.0.1:<port>`. (supertest used to
  open that port itself; since bug-33 the suite opens it through `listenLoopback` and supertest only dials it. The Host header is unchanged, which is the whole
  of what this rule reads.)
- **`localhost`.**
- **Any `.ts.net` name.** `pnpm run tailnet` is the one documented remote path, and this mirrors `vite.config.ts`'s `allowedHosts: ['.ts.net']` deliberately, so
  the API and the dev server answer to the same set. A tailnet name is minted by Tailscale for a node, not by whoever registers a domain. Matched at a label
  boundary at the **end** of the hostname: `evilts.net` and `ts.net.evil.test` both fail.
- **`BM_ALLOWED_HOSTS`** — comma-separated, trimmed, lowercased, empty entries ignored; a leading `.` is a suffix match, anything else is exact. The escape
  hatch for a setup this repo does not ship: a reverse proxy, an mDNS `.local` name, another container calling the API by service name.

Everything else is refused with 403 and `{ error: 'unrecognised Host header' }` — **including an absent or empty `Host`**. HTTP/1.1 requires the header and
every browser and curl sends it, so defaulting an absent one to "allowed" would reopen the hole to a hand-rolled client. The hostname alone is compared, never
the port: the port a request arrives on is the port this process chose to listen on, and pinning it here would plant a third copy of `BM_API_PORT` /
`BM_WEB_PORT` / the tailnet port for no security gain, since an attacker's page must already reach our socket to matter. The variable is read per request with
no cache, the same posture `BM_AGENTS` has.

**What deliberately did not change.** The origin guard's logic: with the gate in front, its equality inherits the allowlist transitively — an allowlisted `Host`
plus equality means an allowlisted `Origin` — so it needs no third check and gains no duplicate of this rule. `Origin: null` and the preflight-free form POST
are still its job. `main.ts` and `BM_BIND`: the bind was never the failure. No `helmet`, no `enableCors()` — neither answers this, and `enableCors` would weaken
it.

## The tailnet serve is a script, and its port is read where compose reads it

`scripts/tailnet.mjs` (`pnpm run tailnet`, subcommands `up` | `status` | `down`) is the sanctioned way around the loopback bind above, and the reason it is a
script rather than a documented one-liner is drift. A `tailscale serve` typed by hand stores a **copy** of the port number inside tailscaled — outside this
repo, outside git, and surviving reboots. compose reads `BM_WEB_PORT` from `.env`; the moment that variable moves because something else on the machine claimed
5177, the copy inside tailscaled keeps pointing at the old port and the phone gets a bare 502 from Tailscale, which reads as a Tailscale fault rather than a
stale mapping. This machine already sits on a non-default `BM_WEB_PORT`, so that is not hypothetical. The script resolves the port the way compose resolves it —
an exported variable wins over the file, and the fallback is the compose default — so there is no second copy to keep in sync, and `scripts/tailnet.test.mjs`
asserts against the source text that `5177` appears exactly once and no other port literal appears at all.

Three properties are deliberate and each costs something if traded away:

- **The tailnet port and the loopback port are the same number.** tailscaled answers this machine's tailnet address, compose publishes on `127.0.0.1`, and the
  two never contend for one socket — so one number names the project wherever you type it. This is what rules out an HTTPS serve: `--https` accepts only 443,
  8443 and 10000, so a browser-trusted certificate and the matching-port property cannot both hold. `off` takes the _listener's_ port, which is why
  `serveArgs`/`offArgs` read one resolved number rather than two expressions.
- **Plain HTTP is not plaintext on the wire.** The hop from the phone to this machine is WireGuard-encrypted end to end; the HTTP exists only inside that
  tunnel, between tailscaled and a loopback socket. The dispatch POSTs survive the terminating proxy because `origin.guard.ts` compares host and port and
  deliberately **not** the scheme — a serve sends `Origin: https://…` while the request arriving here is still HTTP, and comparing schemes would 403 the
  documented setup for no security gain.
- **Never `tailscale funnel`.** Funnel publishes to the public internet. The board reads every registered project's backlog files off this filesystem with no
  auth, and with `BM_AGENTS` on it fronts a POST that spawns a Claude Code session with write permission in another repo. The tailnet boundary is what makes
  both acceptable; Funnel removes it. Avoid `--set-path` too: the SPA references `/assets` and `/api` absolutely and breaks anywhere but a root.

The script refuses to escalate. `serve` edits the node's configuration, so tailscaled rejects it from a user who is neither root nor the declared operator; the
fix is one `sudo tailscale set --operator=$USER`, printed rather than run, because a helper that silently reconfigures your machine's network is worse than an
error message. It warns — and does not fail — when nothing is listening on the loopback port, since registering before `pnpm run docker:up` is a reasonable
order to work in and the registration persists. `--dry-run` prints the command instead of running it, which is what lets the suite pin the argument strings
without reconfiguring the machine that runs the tests.

Ported from guide-manager's `bin/tailnet.js`, which exists for the same reason one variable over (`GM_WEB_PORT`). The layout differs on purpose: there `bin/` is
ESM inside a CommonJS repo and the suite is jest, here the script joins `scripts/` beside `sync-plugin.mjs` and its suite is picked up by `test:skills`'s
existing `scripts/*.test.mjs` glob.

## The served build carries a CSP; dev does not

`server/src/security.ts` sets the header from Nest, so it rides on `client/dist` and on `/api` alike. It is deliberately not a `<meta>` tag in
`client/index.html`: that would apply in dev too, where Vite injects an inline React-refresh preamble a strict `script-src` would block. Dev binds loopback
only, so the build is where the policy earns its keep. `script-src` carries the sha256 of the pre-paint theme script instead of `'unsafe-inline'` — edit that
script and `test/csp.test.ts` goes red until `THEME_SCRIPT_SHA256` follows.

## Dispatch derives the action; it never accepts one

`shared/agent.ts` is the single derivation (`deriveAction`), imported by the board to label a button and by the server to validate a request — one
implementation, so a button can never promise what the API refuses. `POST /api/agents/dispatch` re-scans the item file and 409s when the request's action
disagrees, which is the groomed invariant enforced on the only side that can read the file. The prompt is the one field whose client-supplied content is taken
outright — `action` is checked against the file rather than trusted, `permissionMode` is clamped to the dashboard's ceiling, and `model`/`effort` go through
`pickFrom` against the mirrored `MODELS`/`EFFORTS` lists — so editing the prompt in the launch sheet is the actual point of the sheet. Those last two drop
rather than clamp or reject: there is no ladder to clamp along and nothing in the item file to check against, and `undefined` is what makes `JSON.stringify`
omit the key, which is what makes the dashboard omit the flag — so a name this build has not heard of costs that flag, never the launch, which is the failure
mode a duplicated list has to survive. Note the controller rebuilds the dispatch body field by field, so a new field reaches the service only when it is added
there too.

The controller rebuilds the dispatch body field by field — a new field reaches the service only when added there too — and checks `action` with `isAgentAction`,
never a hand-written comparison chain: that chain is a second copy of the vocabulary, and it is the copy that goes stale. **`AgentAction` has three members**,
and the third is why the two archives no longer share a branch: `deriveAction` returns `capture` for an out-of-scope item, checked by SECTION and BEFORE the
`status !== 'open'` line that would otherwise swallow a `terminal` item. Task-45 put one check ahead of even that — an item whose `source` was not
`files` derived `null` — and task-46's dispatch lift REMOVED it: the skills write a tracker project's items through the API, so all three actions are now as
available for an issue as for a file, and `deriveAction` asks nothing about `source`. See
[a tracker project has no item files](#a-tracker-project-has-no-item-files-and-that-shows-up-in-three-places) for what replaced it, and for why the
orchestrator's own refusal — which did not lift — is now a gate of its own on each side rather than a consequence of this function. A `done/` item still
derives `null` — history genuinely has no next step, where a
rejection does. Capture spawns `backlog-capture` for a **new** item citing `from: <id>`; the original stays rejected and `moveItem` still refuses every move out
of `out-of-scope/`. Archive's Out of scope column is the only surface that renders the control.

## The orchestrate spawn prompt is composed server-side

`ORCHESTRATE_PROMPT` (`agents.service.ts`) is the literal string `/backlog-orchestrate` — `backlog-orchestrate`'s own `SKILL.md` declares that exact phrase as
its `trigger:`, so the constant is that declaration, not an invention on the server side. `dispatch`'s prompt varies by design, because _what to say_ about a
derived action (groom vs. execute) is a client-editable default the launch sheet composes and a human reader may reword before sending; `orchestrate` has no
equivalent decision to leave open — it always means the same thing, "hand this project's whole groomed queue to the skill," so there is nothing legitimate for a
caller to vary. `AgentOrchestrateRequest` (the body shape `POST /api/agents/orchestrate` accepts) has no `prompt` field to begin with, and `AgentsController`'s
handler rebuilds the service call field by field from `project`, `model`, `effort`, `permissionMode`, `ids`, `mergeMode`, `questionMode` and `base` alone — so a
`prompt` sent in the request body is not validated and rejected, it is simply never read. That is the same mechanism `dispatch` already relies on for every field outside its own request type,
applied here to the one field that would otherwise be the sole way an attacker-controlled cross-origin request could make an unattended, headless session do
anything at all.

`ids` was the first thing a caller could put into that string (merge mode, question mode and the base joined it later — see the end of this section), and it is
not an exception to the rule above so much as the clearest statement of it.

**The four influences are not all the same kind of safe, and the difference has to be stated rather than averaged over.** `mergeMode` and `questionMode` are the
tightest: each appends one of exactly two compile-time literals selected by a guard, so no caller-supplied character reaches the prompt through either channel
at all. An `ids` entry is looser — caller text that passed a shape check and was then proved against a closed vocabulary. **`base` is the first and only member
whose caller-supplied text is appended verbatim**, which is why it is proved the way an id is (a ref-name check, then membership in this project's own local
branches — see
[the merge happens in whichever tree holds the base](#the-merge-happens-in-whichever-tree-holds-the-base-and-the-run-removes-only-the-tree-it-made)) rather than
clamped the way a two-member enum is. Any statement here that every appended flag is a compile-time literal is therefore false and must not be restored: it was
true of two flags out of three and is true of two out of four. Each is appended only off its own guard, and each default appends nothing, so a request written
before any of these fields existed composes the byte-identical prompt it always did. The board's Orchestrate sheet can narrow a run to a subset of the queue, which means the
spawned session has to be told `/backlog-orchestrate task-3 bug-7` rather than the bare trigger — `--ids` is a flag `orchestrate.mjs`'s own `init` and `plan`
have always taken, and `SKILL.md` documents the trigger as `/backlog-orchestrate [ids…] [--max N] [--base <ref>] [--merge-mode branch] [--question-mode decide]`. What makes that safe is that the server never _accepts_
prompt text, it _composes_ the prompt out of the constant plus values that have passed two independent checks (`resolveIds`, `agents.service.ts`):

1. **Shape** — `isItemId` (`shared/agent.ts`), the same `^[a-z]+-\d+$` `backlog.mjs`'s own `ID_SHAPE` enforces. What survives is a bare identifier: no
   whitespace, no path separator, no shell metacharacter, and no newline to split the one-line prompt with.
2. **Membership** — the id must name an _open bug or task_ in _the project being orchestrated_, scanned per request. Scoped to that one project deliberately,
   unlike `findItem`'s registry-wide walk: `bug-2` exists in most stores, and accepting another project's id would hand `--ids` a value that `init` then exits
   `1` on, inside a headless session nobody is watching.

Shape alone is far too weak (`bug-999` passes it); membership alone would be running a directory scan over attacker-shaped strings. Together they mean the only
thing a caller can put in that prompt is the id of one of this project's real, runnable items. Malformed input is a 400 and a file disagreement is a 409,
matching the split `dispatch` already makes — and the 409s here are deliberately uncoded, because `RUN_IN_PROGRESS_CODE` means "a run for this project is alive
right now", which an id disagreement is not — see that constant's own doc comment, which is deliberately the only place in the repo that says anything about
which refusals carry it.

Two smaller rules ride along, both about the difference between _absent_ and _empty_. An absent `ids` means "the whole queue" and produces the bare constant. An
explicitly empty `ids` is a 400, never silently read as "everything" — that is `parseIdsArg`'s own distinction in `orchestrate.mjs` (`--ids ''` must not mean
"give me everything") enforced one layer up, at the only place a browser can reach. And the sheet sends `ids` **only when the selection is a strict subset**
(or, since task-20, a hand order): a full explicit list is a different instruction from no list at all, because it freezes the run to the queue as it stood when
the sheet opened, dropping anything groomed and committed while the reader was looking at it.

What a caller can influence is enumerated by the prompt composition in `orchestrate()` and nowhere else — deliberately not by a count in this sentence, which is
the shape of line that already went stale once here. The first influence is `ids`, the board's item selection, and only after `resolveIds` proves every entry
both _is_ an id (`isItemId`, `shared/agent.ts` — the same `^[a-z]+-\d+$` `backlog.mjs` enforces, so no whitespace, path separator, shell metacharacter or
newline survives) and _names_ an open bug or task in **this** project (a per-request scan scoped to `req.project`, deliberately not `findItem`'s registry-wide
walk). Next are `mergeMode` and `questionMode`, tighter surfaces still and identical in shape: each appends a compile-time literal selected by a guard
(` --merge-mode branch` by `isMergeMode`, ` --question-mode decide` by `isQuestionMode`), with no caller string in it at all, and each one's DEFAULT appends
nothing — `merge` there, `park` here — so a default run's prompt stays byte-identical to what shipped before either field existed.

The fourth is `base` (task-44), and it is the loosest of the four in form: it appends the caller's OWN text, ` --base <ref>`, where the other two append
literals. What makes it acceptable is that `resolveBase` proves it the way `resolveIds` proves an id — a ref-name check, then membership in this project's own
local branches — before anything is composed. Its default `'main'` appends nothing, like the other two. Order is ids, then `--merge-mode`, then
`--question-mode`, then `--base`: ids first because the tool reads bare tokens as ids and a flag ahead of them would swallow the first one, and each later flag
appended after the ones that predate it so every prompt this endpoint composed before a given field existed stays a byte-exact prefix of what it composes now.

## The browser never talks to the dashboard

`connect-src 'self'` forbids it and the bearer token must not be in a page, so every call goes board → this API → dashboard. `BM_AGENTS_URL` is env-only and
never client-supplied: there is deliberately no request shape in which a browser names the host this server will call. `BM_AGENTS` defaults to off, so an
unconfigured install makes no outbound request at all.

`BM_AGENTS` defaults to off — and **compose passes that one through as `${BM_AGENTS:-off}`, never as a literal** (bug-25, pinned by `test/compose-env.test.ts`).
A literal there wins outright: the `environment:` block IS `process.env` in the container and dotenv never overwrites a key already in it, so `BM_AGENTS: 'on'`
made the documented default unreachable from the documented Quick start — dispatch buttons _and_ the watchdog sweeper armed, from a `cp .env.example .env`.
`BM_AGENTS_URL` beside it is overridable for the opposite reason, and under a **second key**: it is stack topology, not a policy default, so a passthrough of
`BM_AGENTS_URL` itself would let the host-oriented `.env` line — loopback, which inside a container means the container — break dispatch in the stack. Compose
therefore reads `${BM_AGENTS_DOCKER_URL:-http://host.docker.internal:4173}` and never interpolates `BM_AGENTS_URL` at all, which `test/compose-env.test.ts` pins
from both directions: the exact default string, and a whole-file assertion that no `${BM_AGENTS_URL…}` appears anywhere in it. That second case is the
load-bearing one — collapsing the two names back into one looks exactly like the line it replaces and would read as a cleanup.

Two names rather than one because one key cannot hold both answers when they differ, and they differ on more machines than the original literal assumed.
`host.docker.internal` is a Docker Desktop convenience, not a guarantee: under WSL2 it _resolves_ (`192.168.65.254`, plus an IPv6 address) and then refuses the
connection, because nothing at that gateway forwards to the host's port. The bridge gateways (`172.17.0.1`, `172.18.0.1`) refuse it too, so
`extra_hosts: ["host.docker.internal:host-gateway"]` is not a fix either — the only addresses a container can reach a host process on are the host's own
interface IPs. Prefer a stable one: a LAN address changes on reboot, a tailnet address does not, at the cost of making dispatch-from-the-stack depend on
tailscaled being up.

The failure this produces is worth recognising by sight, because nothing in it names the cause: `GET /api/agents/status` answers
`{"enabled":true,"reachable":false,…,"error":"fetch failed"}` and Settings reports the dashboard unreachable, while `curl 127.0.0.1:4173/api/health` on the host
answers `200`. A healthy dashboard plus an unreachable one is the signature of the container looking somewhere the host is not.

## A project the dashboard cannot see cannot be dispatched to

Its `POST /api/spawn` takes a `dirName` resolved against projects active inside its `LOOKBACK_HOURS` (24 by default), so a quiet repo has no key to send.
Accepted, not worked around: the alternative is teaching that app to take an absolute path, which widens the widest write surface it has. This is one of the
three blocks that leave a control on screen (the other two are a local skill session's `started:` stamp and a live orchestrator run's claim — see the
`dispatchGate` section below): the button's own `title` and its visually-hidden `aria-describedby` span carry the per-item reason (it names the path, and
nothing else in the UI does), while Settings lists the host-level setup — including the two fixes for this one, a session in that repo or a higher
`LOOKBACK_HOURS`. That reason states the missing path as fact and the lookback only as a likelihood ("the dashboard does not list X — most likely no Claude
session there…"), because every reader of the string is one step removed from the dashboard's own answer: the server holds a project map for up to
`PROJECT_TTL_MS`, and a browser tab holds a copy of that. It used to assert the lookback flatly, which is what made a stale block _confidently wrong_ rather
than merely late — it sent people to open a session in a repo that already had one (bug-13, below). Environment-level blocks render no button at all; see that
same section below. Never derive a `dirName` from a path to route around this. The membership check behind it (`status.projectPaths.includes(item.projectPath)`,
in `dispatchGate`, `shared/agent.ts`) is a raw string compare, not a realpath one, even though `agents.service.ts` already calls `realpathSync` elsewhere for
its own item lookup and could afford one here too: `dispatchGate` is one implementation the board also runs in a browser, which has no filesystem to resolve a
symlink with, so the server side stays just as literal rather than let the two sides risk giving different answers. Known consequence: a registered project
whose path reaches its git root through a symlink can show a disabled button even with a live session inside `LOOKBACK_HOURS`, if the dashboard's own recorded
path and the registry's do not match byte-for-byte.

## Environment-level blocks hide the dispatch control; per-item ones disable it

`dispatchGate` (`shared/agent.ts`) answers with `hidden` / `disabled` / `enabled`, and `dispatchBlock` is the flattened string form of the same ladder for the
two callers that only refuse (the launch sheet's re-check and the server's). Dispatch off, dashboard unreachable, no `CLAUDE_BIN`, remote answers off — none of
those is about any one card, all four are true of every card at once, and none is fixable from the board, so they render no button. That is what makes the
promise in the spec and `.env.example` — with `BM_AGENTS` off the board "renders exactly as it does today" and "shows no dispatch buttons" — literally true; do
not "improve" it into a disabled button on forty cards.

The per-item blocks are the opposite case and keep their button. There are **three** of them, not one, and only the first is anything `dispatchGate` itself can
answer:

- **The dashboard cannot see this item's project** — `dispatchGate`'s own fifth line, the section above.
- **A local skill session already holds this item** — `progressBlock` (`client/src/lib/item-progress.ts`), and the only one of the three derived from the item
  file itself. It is the exact mirror of the block below it: `started:` has one writer (`backlog.mjs start`) and one clearer (`stop`), so a session grooming or
  executing an item states that in the frontmatter the board is already reading — `isInProgress` had been deriving it for the card's amber bar since before
  dispatch existed, and nothing ever wired that predicate into the dispatch path. It blocks on ANY stamp, fresh or stale, matching `start`'s own rule that any
  stamp refuses: a stamp nobody is behind is a lie the board must not paper over, and `stop` is the one-command fix for it. What stops an ancient stamp from
  blocking forever is `isInProgress`'s `status === 'open'` half — `move` never rewrites content, so an archived item's stamp is history rather than a claim. It
  lives in `item-progress.ts` and not in `shared/agent.ts` beside `runClaimBlock`, breaking that file's otherwise complete ownership of the block vocabulary on
  purpose: it is built from `isInProgress` and `progressLabel`, which are both already there, `shared/` must not import from `client/`, and hoisting the pair
  over would be a move made for a block the server has no use for. Client-only is the whole decision, not an omission — the board is the only surface that can
  double-dispatch, and the server's dispatch re-scan is unchanged. Unlike the run claim there is nothing here for the server to catch late: the skills already
  refuse (`start` will not stamp a file that carries a stamp), so what a second spawn cost was never a corrupted file but a wasted session and a refusal the
  user had to go and interpret — `backlog-groom` opening the whole "whose marker is this" conversation about a marker its own board set ninety seconds earlier.
- **An orchestrator run has already claimed this item** — `runClaimBlock` (`shared/agent.ts`), which reads the run payload rather than the item. It has to: a
  run works each item inside its own git worktree and nothing reaches `main` until the item merges, so while a run holds `task-7` at `reviewing` the `task-7`
  file `/api/items` scans on `main` looks untouched — no `started:`, no `phase:`, nothing `isInProgress` could key off. The item is not lying; it is telling the
  truth about `main`. Claimed means a stage in `RUN_CLAIMED_STAGES` (`shared/types.ts`) on a run that is _fresh_: the eight non-terminal stages, `pending` and
  `preflight` included, because a pending item is already the run's and a manual session that grooms or archives it first leaves the run dispatching into an
  item that moved under it. The seven exits (`merged`, `branched`, `failed`, `skipped`, `needs-answers`, `ungroomed`, `parked`) are out — the run is finished
  with the item, and a human picking it up by hand is the intended next move, `parked` most of all. That list is deliberately NOT `ACTIVE_RUN_STAGES` (client
  `ItemCard.tsx`), which answers "does this card show a live stage badge" and correctly excludes `pending`/`preflight`; the two overlap by six members and must
  not be unified. This block is checked on the board and again in `dispatch()`, the second being the one that holds: the launch sheet fetches its plan once on
  mount, so a sheet left open while a run starts still shows an enabled launch button, and only the server sees the run as it is at click time.

`DispatchButton` reads all four in one order — environment-hidden, then project visibility, then the in-progress stamp, then the run claim — most fundamental
first, so the reason on screen names the thing to fix rather than a symptom of it. With dispatch off or the project invisible there is nothing worth saying
about either kind of session that might hold the item. The last two rungs are in that order for the same reason applied one level down: the `started:` stamp is
on the very copy of the item this board is rendering, while a run claim is a fact about another worktree that the next poll can change, so the file wins. They
coexist only pathologically — a run stamps `started:` on its own worktree's copy, which is exactly why `runClaimBlock` has to exist, so the registry's copy of a
claimed item normally carries no stamp at all — but a reader who has both is better served by the one they can go and look at.

This was bug-4: the run claim existed nowhere in the ladder, so a card an unattended run already owned kept a live dispatch tab, and clicking it spawned a
second session against an item held in another worktree on `backlog/<id>`.

The in-progress block was bug-12, the same shape one rung down and with the data in the opposite place: the card rendered its amber in-progress bar and an
enabled dispatch button side by side, one telling the reader a session held this item and the other offering to start a second one against it.

**One of the three lets the click through anyway, and only one: a project-visibility block re-asks the status instead of swallowing the click** (bug-13).
`useAgents` refetches on mount and window focus alone, deliberately — what changes the answer happens outside the tab and you come back to the tab afterwards —
and that reasoning simply has no purchase on a window that never loses focus (a board on a second monitor, or the only window in use). The staleness that
follows was argued to be bounded: `PROJECT_TTL_MS`'s own comment said a minute of it "costs a disabled button that would have worked, which the sheet's own
re-check then corrects". True in exactly one direction, and — as bug-16 later found — only of this control. A stale _enable_ is corrected by `LaunchSheet`,
because clicking opens it and `plan()` re-derives the block server-side; a stale _disable_ is not, because the sheet that would correct it is behind the control
the stale answer just made inert. The self-correcting path was unreachable from the state that needed it, so the board sat on a confidently actionable message
that was no longer true with nothing in the UI able to clear it.

So the click asks. `DispatchButton` takes `reverify` — the board's own `useAgents().reload`, which now RESOLVES to the status it fetched rather than only
setting state (the setState lands a render too late for the handler that provoked it) — calls it once, marks itself `aria-busy` while it waits, and opens the
sheet only if `dispatchGate` reads `enabled` against the _fresh_ answer. Worst case is one wasted request and a button that stays disabled, with the reader now
able to see it was actually asked; the server is authoritative either way and `plan()` re-checks on open regardless. Note the one bound that remains: the
refetch can still be answered from the server's own `PROJECT_TTL_MS` map, so a re-ask inside that minute can legitimately come back with the same list — the fix
removes the _unrecoverable_ state, not the cache.

The scope of that exception is the fix, not a gap in it. The run claim keeps swallowing the click: `useOrchestratorRuns` polls every 5s while any run is fresh,
so it is never stale in this way, and a claimed item genuinely must not be hand-dispatched. The in-progress stamp keeps swallowing it too: it is derived from
the very item file the board is rendering, so no status refetch could move it. And a button blocked by project visibility _and_ one of those two behaves as that
block's case — clearing the visibility half would leave the click refused anyway, so there is nothing worth asking. Two alternatives were rejected on the way: a
polling interval on `useAgents` asks the same question on a timer for every reader whether or not anyone is looking at a blocked button, which is what the
mount+focus cadence was chosen over; and a `visibilitychange` listener narrows the window without closing it, since the failing case has the tab visible and the
window focused the whole time.

### The toolbar's Orchestrate control asks the same question, from one hook

bug-16 is bug-13 one control over. The board toolbar's Orchestrate button is gated by the same `projectDispatchGate`, renders the same reason string, and sat
inert behind the same stale `projectPaths` array — bug-13 deliberately did not touch it, because its own Fix and Affects named the per-item control only. Worse
there than here in one respect: a project-scoped control is the entry point to an unattended queue drain, so the reader who cannot start a run has no per-card
fallback for the whole queue, and the message sends them to fix something that is already fine.

The mechanism is now shared rather than written twice. `useReverify` (`client/src/hooks/useReverify.ts`) owns "ask once, mark `aria-busy`, act on the fresh
answer"; both `DispatchButton` and `BoardView`'s toolbar call it, and `test/dispatch-button.test.tsx` passing unchanged is what makes that extraction a refactor
rather than a rewrite. What the hook deliberately does NOT own is the gate check: the two callers derive different answers (`dispatchGate(item, fresh)` versus
`projectDispatchGate(fresh, path)`) and have different sibling blocks, so folding the policy in would mean a config object per caller. The drift-prone half is
the mechanics — a hand-written copy that acts on the stale render, or drops the in-flight guard, looks right and is wrong. The Escape effect the four dialogs
each carried their own copy of read as one of the stateless idioms this repo repeats on purpose, right up until bug-23: two of those dialogs are mounted
together by design, so one press ran both callbacks. It is now `hooks/useDialogEscape.ts` — one stack, one listener — which makes it the same lesson as this
hook rather than the counterexample to it.

Three differences from the per-item case, each a consequence of the control being project-scoped rather than item-scoped:

- **No three-condition `reverifiable`.** `showOrchestrate` _hides_ the button for the environment ladder, for an unfiltered board (`projectValue === ALL` leaves
  the gate `null`) and for a project with a fresh run. So a rendered disabled button is blocked on project visibility and nothing else — the condition reduces
  to "the reason is non-null", and the hook's own in-flight guard covers the rest. The fresh-run rule must not be re-derived from a status refetch in any case:
  it comes from `useOrchestratorRuns`, which polls every 5s while any run is fresh and which a status payload cannot see at all.
- **The project is captured at click time**, not re-read when the answer lands. The filter is a live `<select>`; the sheet has to open for what the reader
  clicked. There is deliberately no "the filter moved, discard the answer" guard: `orchestrating` is keyed on the project path precisely so a sheet outlives a
  filter change, and the window is one request wide.
- **The sheet cannot correct a stale answer in either direction.** `OrchestrateSheet` takes `spawnMaxPermission` alone rather than the whole `AgentsStatus`, and
  argues against re-running the gate's checks client-side; it calls `fetchMergeCheck` on open and nothing else. Its only server re-check is at **Start**, where
  the same gate runs server-side and returns an _uncoded_ 409 the sheet renders as an error and stays open on. That second half is not a defect to fix — it is
  the reason the fix could not be "let the sheet sort it out."

## One run per project, checked twice

`orchestrate.mjs init` is the authoritative lock: it refuses outright — exit code 4, nothing written — whenever the project's existing run file still says
`status: "running"`, whether that heartbeat is fresh or stale. A fresh one is the easy case, a second process about to stomp on a live run's state. A stale one
is deliberately refused too, rather than treated as free: `status: "running"` with an old `updatedAt` is not an idle lock, it is the last known state of a run
that crashed mid-item, and silently starting over on top of it would bury that crash without a trace — an orphaned worktree and branch leaking forever, a dead
`started:`/`phase:` marker billing wall-clock time nobody notices. Recovering it is deliberately not plain `init`'s job; the refusal names `--resume` and
`--abort` by name so the person looking at it is never left to guess. `POST /api/agents/orchestrate` cannot rely on that check alone, because a click on the
board's own control reaches the dashboard's spawn endpoint directly — the one path into a new run that never calls `orchestrate.mjs init` at all before
something starts. So `AgentsService.orchestrate()` re-reads the orchestrator's own run list and checks the same project for a run with `fresh === true` (the
`RUN_STALE_MS` freshness check, not the skill's broader fresh-or-stale one — a stale run here is left for the spawned session's own `init` to catch and diagnose
properly, since only the skill side knows how to offer `--resume`/`--abort`) before it will spawn anything. This is belt-and-suspenders in the same shape as the
registry's single-writer rule: the check that truly matters lives with the writer, and every other path capable of triggering one re-checks it rather than
trusting that callers will always go through that writer. This 409 carries a `code` (`RUN_IN_PROGRESS_CODE`, `shared/types.ts`) — a prior incident had a client
guess which 409 it received by matching a substring of the `error` prose, which broke the moment the wording changed, so the fact "a run for this project is
alive right now" gets a stable, machine-readable answer while the 409s that mean something else deliberately do not, nothing about them needing to be told
apart. Since bug-21 that fact is reachable one window earlier too, before any run file exists, and the starting lock answers with the same code for the same
reason. Which refusals carry it is stated in the constant's own doc comment and nowhere else, this file included — a tally kept in a second place has gone stale
every time a sender was added.

## A board-started run is visible before its run file exists

A board-started run is visible before its run file exists, from server memory that is never written to disk. `GET /api/orchestrator/runs` can only see
`run.json`, and `orchestrate.mjs init` writes it in SKILL.md §2 — after the dashboard spawn, the session boot, a full SKILL.md read and the §1 `plan` turn, i.e.
1–5 minutes in which the board showed nothing and a click that silently failed looked identical to one that worked.

`StartingRunsService` closes that FEEDBACK gap only; boot latency is unchanged and nothing here makes a run start sooner. It is a `Map<project, requestedAt>` in
the API process, lost on restart on purpose, and adds **no** writer to the run file — the alternative of having the server call `init` itself was rejected
because the spawned session would then hit `init` exit `4` (lock held), whose documented answer is "never retry, go to `--resume`".

It rides the payload as a **separate top-level `starting` array**, never a `status: 'starting'` member of `runs`: that array is documented as a verbatim read of
a file `orchestrate.mjs` wrote and is iterated by `aggregateRuns`, `ArchiveView` and `RunsView`, so a synthetic member would reach all of them and every
exhaustiveness site, where a separate field reaches only what opts in.

An entry dies on any of **three** rules: a run in the same payload matches the project AND its `startedAt` parses to at or after `requestedAt` — **`startedAt`,
not "a run.json exists"**, since `cmdInit` archives the old file and writes a new one, so a project that has ever run always has one; or the entry is older than
`RUN_STALE_MS`, the app's one freshness number, reused rather than joined by a second; or **a run for that project already reads `status: 'running'`, fresh or
crashed** (bug-21) — keyed on that status exactly, never on `!fresh` and never on "a run file exists", because `cmdInit` archives a `done`, `aborted`, `failed`
or `paused` file before writing the next one, so a project holding any of those can legitimately start a new run and must keep its placeholder.

Rule 3 used to be a render-time filter in `BoardView` guarding one thing (two strips for one project); it is server-side because the four gates below all need
it and the server's own lock can read it from nowhere else.

It is `mark`ed from `AgentsController` **after** the awaited spawn, beside `arm()` and for the same layering reason, so a failed spawn leaves no ghost; `runs()`
calls the pure `list()` and `OrchestratorController.runs()` calls the mutating `sweep()`, the same pure/mutating seam `annotate()`/`observe()` already keep,
both deferring to one shared predicate. Correctness never depends on the sweep — `list` re-applies all three rules every call, so an unswept map leaks at most
one entry per project and never lies, which is what makes `AgentsService`'s own direct `runs()` calls safe without one.

The board reads `starting` straight, with **no client-side filter**: rule 3 is what rules out the collision that filter existed for — a placeholder drawn beside
a `running` run file's own row — and keeping a second expression beside it that merely agreed is the shape `watchdogStoodDown` and `isStale` are each one
function to avoid. The reader was `StartingStrip` until task-37 and is `RunChip` (`client/src/components/board/RunChip.tsx`) now, which counts the array into
its own line (`1 starting ›`) under the same rule. It is deliberately not a guarantee of one row per project in every case: the old strip's list was
`running || paused` while rule 3 is keyed on `running` alone, so a stale `paused` run plus a live starting entry counted two, which is reachable and correct —
they are two different runs, and widening rule 3 to `paused` to suppress the second would strip the placeholder from a project that can legitimately start a
run.

`POST /api/agents/resume` is deliberately not marked: the run it resumes already reads `running`, so the board is already counting it — as a crashed run, since
its heartbeat is what stopped — and the screen was never blank. That counting was the crashed strip until task-37 and is `RunChip`'s own line
(`1 run · crashed ›`) now; what makes the rule hold is that a `running` run file is visible either way, not which control draws it.

### A starting entry blocks what a run file blocks (bug-21)

A starting entry blocks what a run file blocks, on every surface (bug-21). For the 1–5 minutes before `init` writes `run.json` the entry is the only evidence a
run exists. task-14 made that window visible as a strip, but every gate still read `payload.runs` alone — so a person could hand-dispatch an item the pending
run was about to claim in its own worktree (the double execution bug-4 and bug-12 each closed), and a second Orchestrate press returned 200 and spawned a second
session that died at `init` exit `4`.

`runClaimBlock` (`shared/agent.ts`) takes `starting` as a **required third parameter, no `[]` default** — the same rule `isStale`/`leavesBoard` follow for
`runs`, because the compile error at each of its four call sites (`BoardView`, `ArchiveView`, `plan`'s `blocked`, dispatch's 409) is the mechanism that makes
the next caller decide instead of silently reinheriting this — all four were blind in the identical way, which is what a default would have made easy to repeat.
(`BoardView`'s call site is its `runBlockFor` helper.)

The block it produces is **project-wide and deliberately coarse**: a `StartingRun` is `{ project, requestedAt }`, and even carrying the launch's `ids` would not
help, since what a run actually queues is `buildGatedQueue`'s verdict inside the spawned session minutes later. A wrong allow costs a duplicated execution; a
wrong block costs a wait bounded by the run file landing. Per-item wording wins over the coarse one where both could apply. The function's NAME was left
unchanged when `starting` was added: a starting run is a run, and the question it answers — "why does a run forbid dispatching this item" — has not moved.

The toolbar Orchestrate control **hides** on a starting entry rather than disabling — that is what preserves bug-16's `showOrchestrate` reasoning, in which a
_rendered_ toolbar button is blocked on project visibility alone. And `POST /api/agents/orchestrate` refuses a starting project with the **same**
`RUN_IN_PROGRESS_CODE`, beside the `activeRun` throw and therefore still before `resolveIds`: it is the same lock one window earlier, and `OrchestrateSheet`
already branches on that code to close and hand the screen to the board's run chip, which is already counting the starting entry the second press would have
duplicated — which is exactly right here. (It was `StartingStrip` until task-37; the source-side half of this sentence lives in `OrchestrateSheet.tsx`'s own 409
comment, and the two are meant to read the same.)

`runHoldsItem` deliberately does NOT gain the parameter: its caller asks "is a run holding THIS item", which a placeholder naming no items cannot answer, and
the window is ≤15 minutes against a 30-day staleness threshold. Pinned by a test rather than left as prose.

#### Why `runClaimBlock` has to exist at all, and why it is one function

It is the fourth kind of dispatch block and the only one reading something other than an item file and a dashboard status, because the two things it compares
can never learn about each other on their own. An orchestrator run works each item inside its own git worktree and nothing reaches `main` until the item merges,
so while a run has `task-7` at `reviewing`, the `task-7` file `/api/items` scans on `main` looks untouched — no `started:`, no `phase:`, nothing `isInProgress`
could key off. The item is not lying; it is telling the truth about `main`. "This item is claimed by a run" therefore exists in exactly one place, the run
payload, and every surface that needs it has to be handed it explicitly.

It does the whole lookup — project match, id match and freshness filter together — rather than exposing a stage-to-reason helper each caller invokes after its
own lookup. Those three lines are exactly the part a second copy gets subtly wrong, and `environmentBlock`, a few functions above it in the same file, records
that having already happened once: `orchestrate()` reimplemented one of `dispatchGate`'s five lines and silently dropped the other four.

It filters on `fresh`, not `status === 'running'`. A stale run has stopped reporting, and freshness is the rule every surface that makes a claim about an ITEM
uses: this block, `runHoldsItem` behind `isStale`/`leavesBoard`, and the card's own live strip, all fed from the board's fresh-only map (`freshRuns`,
`BoardView.tsx`). A crashed run may still hold a worktree, so blocking on staleness is arguable, but that is a recovery problem `--resume` and `--abort` own,
and cards dead until someone runs one of those is a worse failure than the double-dispatch this exists to prevent.

That is a split, not a universal, and task-37 is where it stopped being both at once. It used to read "freshness is already the rule every other run-derived
surface uses — the run strip renders nothing for a stale run", and the strip's silence was the evidence. The strip is gone and its replacement is deliberately
NOT freshness-gated: `runChipReading` (`RunChip.tsx`) counts a stale `running` run through `isCrashed` and draws a chip for it, because "a crashed run renders
as crashed, never as nothing" is that control's whole job. So the rule to carry forward is per-question rather than per-surface — **a claim about one ITEM is
freshness-gated; a count of what the RUNS are doing is not** — and a future session widening one must not read this section as licence to widen the other.

## Every agents POST is guarded by content-type and origin

(`server/src/agents/origin.guard.ts`) — this is the one place in the app where loopback is NOT the access control. Nest registers `express.urlencoded` on every
app it builds, and `application/x-www-form-urlencoded` is a content type a cross-origin HTML form posts with no CORS preflight — so before this guard existed,
any page in the developer's browser could auto-submit a hidden form at `/api/agents/dispatch` and spawn a session with an attacker-written prompt. The browser
is already inside the loopback boundary; a bind cannot help. Both halves are load-bearing: a non-`application/json` content type is refused (which forces a
preflight there is deliberately no `enableCors` to answer), and a present `Origin` that is not this request's own host is refused (which is what closes
`Origin: null` from a sandboxed iframe). Absent `Origin` stays allowed — curl and every server-side test send none. `GET /api/agents/status` and
`GET /api/agents/watchdog` are deliberately outside it, like every other GET here. Known consequence: a TLS-terminating proxy in front of this that rewrites
`Host` without rewriting `Origin` will 403 — the guard compares host and port only, not the scheme, precisely so a `tailscale serve` that preserves `Host` keeps
working. Known **limit**, closed elsewhere: neither half answers DNS rebinding, where one page controls `Origin` and `Host` together and they agree — see
[Every route is gated by a Host allowlist](#every-route-is-gated-by-a-host-allowlist), which is the layer that does, and which this guard now sits behind.

`dispatch` is the guard's original, motivating route — the hidden-form story above is its own. `plan` carries the identical guard because it also reads an
arbitrary registered item and reaches the dashboard; `orchestrate` and `resume` carry it because each spawns a headless session the same way `dispatch` does;
`watchdog/config` carries it because it writes a settings file that changes this server's own spawn cadence, and because a save there can itself kick an
immediate spawn (see "The watchdog spawns" below) — a cross-origin page must not drive either effect. The set has grown from one route to five without the guard
itself ever changing, which is exactly why this section's own heading used to name a count ("the two agents POSTs…") and went stale the moment a third route
(`resume`) landed, then again when a fourth and fifth did: `test/agents-origin-guard.test.ts`'s own parametrized route list — `plan`, `dispatch`, `orchestrate`,
`resume`, `watchdog/config` — is where the actual set lives now, not a number carried in this prose.

## Launch sheet model/effort pickers seed from Settings, never the last launch

`dispatchDefaultModel` / `dispatchDefaultEffort` (`client/src/lib/settings.ts`, mirroring the dashboard's own `spawnDefaultModel` / `spawnDefaultEffort`) are
per-device like every other key there, default to `''` — no flag, the CLI decides — and are clamped against the same `MODELS`/`EFFORTS` the sheet renders, so a
stored name can never be one the selects cannot show. Remembering the _last pick_ stays rejected: a sticky `max` from last week quietly spending on a trivial
groom is the failure a per-launch control exists to prevent, and a default you set once in a row you can go and read is the opposite arrangement. Permission
mode deliberately has no stored default — it comes from the server's `plan.defaultMode` and is clamped to the host ceiling, and a remembered mode would fight
that ladder. That server-side default is `auto`, because a dispatched session runs unattended: nobody is necessarily at the terminal a permission prompt would
appear on. What a lower rung actually costs is worth stating precisely, because the earlier wording here ("a session that stops on its first unapprovable tool
call and silently does nothing") was half right, and half right is worse than wrong. Measured against CLI 2.1.250: it does _not_ stop and it does _not_ do
nothing. A refused call returns an ordinary `tool_result` with `is_error: true`, the session reads it and **improvises around the refusal**, and the run still
exits `0` reporting `subtype: "success"`. So the hazard a too-low rung buys is not a wedged session anyone would notice — it is a session that quietly reached
its conclusion by some other route, with the refusal recorded nowhere but the transcript's `permission_denials` array. That is the failure mode the ladder's
default sits where it does to avoid. `auto` is still not the top rung — `bypassPermissions` stays a per-launch choice, since asking for the most a host allows
by default is how a convenience becomes an incident — and the ceiling clamps `auto` down on a dashboard that caps lower, so this never widens a stricter host.

`backlog-orchestrate` reaches the same conclusion from the other side. It used to hard-code `--dangerously-skip-permissions` on its headless dispatch, justified
by a premise the paragraph above disproves — that a prompt inside a headless session is a hang. It now dispatches under `--permission-mode auto` like everything
else here, and because `auto` can genuinely refuse a call, it reads `permission_denials` off the transcript's last `result` event before it judges an item clean
(`orchestrate.mjs`'s `readPermissionDenials`, surfaced as `orchestrate.mjs denials`). The mode each session ran under is recorded on its queue item
(`RunQueueItem.permissionMode`), so a denial found in a log has the mode that produced it sitting next to it.

## `linkBase` is per-device and becomes an href

`clampSettings` routes it through `clampOrigin`, which parses it as a URL — the browser's own parser, not a regex — and rejects any scheme but `http(s)`. It is
the one settings key a hand-edited localStorage value could turn into script execution.

## Escape has one owner, and the topmost dialog is the only one that closes

Escape has one owner, and the topmost dialog is the only one that closes. `hooks/useDialogEscape.ts` is a module-level LIFO stack plus a single `window`
listener, installed on the first entry and removed with the last; all three dialogs — the item modal (`board/ItemModal.tsx`), `LaunchSheet` and
`OrchestrateSheet` — call it and none binds its own listener. There were four until task-37: `RunDrawer` left the Board with the rest of the run's detail, which
is the Runs page's own sheet — inline, beside the list, never a dialog — so it is off the stack rather than migrated onto it, and `useDialogEscape` itself is
untouched. They used to bind four, unguarded, and two of them are mounted together by design — Board and Archive both keep the item modal open behind the launch
sheet — so one press ran both callbacks and took the modal with the sheet (bug-23).

Since task-40 the three do not call the hook themselves either: the two overlay SHELLS do. `ui/Modal.tsx` is the item modal's, `ui/FormSheet.tsx` is both
sheets', and each calls `useDialogEscape` once, so a fourth surface opened through either shell joins the stack by construction rather than by remembering to.
The count is still three because the shells have three composers, and `test/dialog-escape.test.tsx` mounts all three together to prove the ranking holds across
them.

Ranking is by **mount order**, a contract and not an accident: the entry's position is fixed for the dialog's mounted lifetime (registration effect keyed on
`[]`, `onClose` read through a ref rewritten every render), because every call site passes an inline arrow and an effect keyed on `[onClose]` would re-push the
drawer above the sheet on the next runs poll. Entries are removed by identity, never popped — a dialog can unmount from under one that is still open.

Module state rather than a context, the shape `lib/view-keys.ts` already uses: Board and Archive are separate lazy chunks and four suites mount these components
standalone.

Knowingly out of scope: nothing traps focus, so a drawer opened _after_ the sheet ranks above a sheet still painted over it — ranking by paint order would mean
a z-index registry.

## A resume is serialized at three layers

bug-19. On 2026-09-05 two live sessions held one crashed run (`run-20260905-113818`) inside one afternoon, in two different shapes, and earlier that day three
sessions were spawned against it inside ten seconds. The three were harmless only because a spend limit killed all of them ~600ms in, before any of them reached
a heartbeat — the design did not stop them.

Two `--resume` sessions on one `run.json` is not a cosmetic race. Both reconcile, both stage-write, and both end in a merge into the run's base; `run.json`'s
single-writer guarantee is a statement about which PROGRAM writes it, which two instances of that program satisfy while destroying each other's state.

**Why one check could never have been enough.** `--resume` is not a command. `orchestrate.mjs`'s dispatch table has no `resume` entry: it is a prose flow in
`references/recovery.md` that a session carries out with the ordinary commands. `init` is the only command that takes a lock, and a resume never calls it —
deliberately, since exit `4` is what `init` answers for the very run file a resume exists to take over. And the fact a check would test does not change fast
enough to help: a resumed session needs ~90s to reach its first heartbeat, so for that whole window every arriving call re-reads the identical stale run file.

**Layer 1 — the board.** The crashed strip's Resume control had no in-flight guard and, worse, no feedback: a successful resume changed nothing on screen, so a
click that worked and a click that was swallowed looked identical for a minute and a half. That is what supplies a person's second and third click. It now
carries a synchronous `busy` flag (the same one `RunControls` already had) and reads `Resuming…` while a request is out, and the board's own `resuming` mark
holds past the request — see the `noteResume` section above for why that mark's end condition had to change from `running` to `running` AND `fresh`. This layer
alone closes nothing: two tabs, or a click racing a watchdog tick, defeat it.

**Layer 2 — `AgentsService.resume()`.** One lock, `WatchdogEntry.resumeSpawnAt`, on the one method both origins share. Four things about it are decisions, not
details:

- **Synchronous.** The check and the stamp sit in one run of the event loop, before the method's next `await`. A lock taken after an await is not a lock; it is
  a check that every concurrent caller passes, which is exactly what `noteBoardResume` — called from the controller, after `await this.agents.resume(...)`
  returns — could never fix from where it stands.
- **`RUN_STALE_MS`, not a new number.** The question is "is a resume session believed to be alive in this run", and this app computes liveness once. A resumed
  session that has not heartbeated in fifteen minutes is dead by the app's own definition and a second resume is then right.
- **Cleared when the spawn throws.** A spawn that threw started no session; keeping the stamp would silence the board's only resume control for a quarter of an
  hour because the dashboard was briefly down. Grace still covers the failure case, and is untouched — grace is a backoff (write-only from a board click, read
  only by the sweeper), this is a lock.
- **Uncoded 409.** `RUN_IN_PROGRESS_CODE` means "a run is alive for this project, right now", which is false here: the run is crashed and a resume is on its
  way. Both callers treat that code as a silent success, which is the wrong reaction to being told to wait.

A consequence to leave alone: with `graceMs` at ten minutes and the lock at fifteen, the sweeper's second attempt is refused at t+10m (a `failed` line, no
attempt spent, grace re-stamped) and lands nearer t+20m. That is correct — the first resume was still inside its own liveness window — and it is pinned by
`test/watchdog-sweep.test.ts`.

**Layer 3 — the driver lease in the run file.** The durable one, and the only one that can refuse a resume this app never asked for. Occurrence 2 was one
backlog-manager resume (`claude -p --session-id <new> … -n resume <project>`, this app's spawn) racing a dashboard session-resume
(`claude -p --resume <existing id>`, `buildSpawnArgs` in the dashboard's own repo). Nothing in backlog-manager requested the second, nothing here can see it,
and no lock this repo adds to its own server could ever refuse it. The run file is the one component both shapes reach.

`driver: { sessionId, at } | null` is written by `init` and by the new `claim` command and read by every mutating command; `status`, `plan`, `denials` and
`reconcile` stay unchecked, because an evicted session must still be able to find out what happened. Identity is `CLAUDE_CODE_SESSION_ID` — the same id
`backlog.mjs` reads for token accounting, and never a synthetic per-process id, which would present a different identity on every invocation and lock a run out
of its own second command. **Absent means unclaimed, never locked**: every run file written before this existed lacks the key. An unidentified caller (a
hand-run terminal) warns and proceeds rather than being refused — refusing would strand the one person recovering a run by hand.

**Two commands take the lease instead of checking it, and that is the rule rather than a hole in it** (review round 1). `abort` and `unpause` are the two whose
premise is that the previous driver is gone, and guarding them turned the lease into precisely what this section says it must never be — the thing that strands
a run:

- A crashed run carries the lease of the dead `init` session. `--abort` never claims (its section opens with the bare command), so every abort was refused with
  `7` — "another session has taken it over", which was false — and `init` refuses any `running` run file, fresh or stale, with `4`. The project was locked out
  of the orchestrator through every supported path at once.
- A paused run carries the lease of the session that paused it and then exited. The `--resume` flow reaches `unpause` before `claim`, because a run has to be
  `running` before there is anything to drive, so a board Resume of a paused run exited `7` on its first write and stopped — task-17's whole pause → resume
  round trip, with the remaining queue abandoned.

TAKING the lease, rather than merely skipping the check, is what makes this independent of the order the prose prints: an `unpause` that left the old lease in
place produces a run that is `running`, fresh and foreign-led, which is the one state `claim` refuses — so the brick would have moved one command later instead
of going away. Both apply `claim`'s own refusal rule, so a run another session is actively heartbeating still refuses both, and the answer there is to pause it
from the board (a pause needs no lease) and abort the paused run.

The rule lives in the tool rather than in an extra `claim` step in `references/recovery.md`, for the reason SKILL.md gives about prose generally: that file is
read once by a session that then takes several hundred turns, and a step it skips is a brick. A rule a command applies to itself cannot be skipped.

The guarantee is a deterministic single survivor with no cross-process locking primitive: on a crashed run both resumers may claim, the later write wins, and
the loser's very next write exits `7` and stops it. Last-writer-wins — the property that makes a racing `stage` dangerous — is what makes `claim` safe, because
exactly one claim is visible afterwards and every subsequent write is checked against it. `claim` refuses one situation only: a run that is `running`, FRESH,
and led by someone else. A crashed run is claimable by anybody, which is the point — that is the state a resume exists for, and refusing there would make the
lease the thing that strands a run.

**The layer-2 lock outlives the sweeper's interest in a run** (review round 1). `resumeSpawnAt` lives on `WatchdogEntry`, and `sweep()` used to prune every
entry whose run was not `running` — which a `paused` run never is. Any tick, including one armed by a completely different project, deleted the entry and the
lock with it, and the next Resume click spawned a second session into a run already being resumed. Crashed runs were never exposed, since a crashed run IS
`status: 'running'`. The keep set now includes `paused`, built in `sweep()` where the payload is read rather than inside `prune()`, so retirement policy stays
in one place and every genuinely finished status still prunes on the next tick. `test/agents-resume.test.ts`'s paused-lock case passes with or without this — no
sweep runs inside it — so the pin is `test/watchdog-sweep.test.ts`'s own case, which ticks between the two resumes.

Exit `7` rather than `1` for exit `6`'s reason: the reaction is not "fix this call and retry" but stop, write nothing more, exit. `references/recovery.md` says
so in as many words, and it is the loser stopping on the first refusal that makes the whole thing a guarantee rather than a delay.

## The watchdog spawns; it never writes the run file

Full design: `docs/superpowers/specs/2026-09-04-orchestrator-watchdog-design.md`.

On 2026-09-03, `run-20260903-112622` (backlog-manager, four bugs) went quiet at its last item and nobody knew for four hours:

| time (UTC) | what happened                                                                                                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14:55      | bug-15 enters `reviewing`; the orchestrator dispatches the reviewer subagent                                                                                                                        |
| 15:02      | the subagent dies: `API Error: 529 Overloaded`                                                                                                                                                      |
| 15:02:41   | the orchestrator schedules `sleep 120` in the background, prints a status table, ends its turn                                                                                                      |
| 15:02:46   | the headless `claude -p` process exits — a print-mode session terminates background work a few seconds after its final result. `run.json` stays `status: "running"`, `updatedAt` frozen at 14:58:51 |
| 15:13      | the run crosses `RUN_STALE_MS` (15 minutes). `RunStrip` renders nothing for a stale run, so the board's only window onto it disappears                                                              |
| 18:57      | a person types `/backlog-orchestrate --resume` by hand; verdict in 4 minutes, bug-15 merged 19:31                                                                                                   |

Every existing piece had worked: staleness was detected on time, `reconcile` read the disk correctly, and the hand-typed resume finished the item in 35 minutes
of machine time. The only missing part was a _trigger_ — and the board's silence for a stale run hid the one fact that would have prompted a person to supply
one. `RunStrip`'s own old doc comment argued, correctly, that a stale run's reported _stage_ can't be trusted (has it moved on three times since, or died
exactly here?); it then drew the wrong conclusion from that — that the whole strip had to say nothing — when "no heartbeat for 4h" was a fact the payload could
have stated the entire time. The watchdog (`server/src/agents/watchdog.service.ts`) is the missing trigger and nothing more: it decides _when_ `--resume` is
spawned, never _what_ `--resume` does, and it is never the run file's writer — that stays `orchestrate.mjs`'s alone (see "The orchestrator's run file has
exactly one writer" above) — the resumed session's own heartbeat is what turns `run.json` live again, exactly as if a human had typed the trigger themselves.

The user's own ask, verbatim, ahead of any of this being designed: "a self-recovery mechanism that verifies every N minutes if any orchestrator is still running
… monitors all orchestrators and makes sure that nothing is blocked."

### Armed, idle, off

Three phases, and no standing interval backs any of them:

- **Armed** — a `setTimeout` chain is pending because at least one `run.json` reads `status: "running"`, fresh or crashed alike. Arms on a boot-time scan, on
  every `GET /api/orchestrator/runs` whose payload already holds a `running` run (the read the board already makes on mount, focus and its own poll), on a
  successful `orchestrate`/`resume` spawn, and on every `POST /api/agents/watchdog/config` save (`agents.controller.ts`'s `watchdogConfig`), which calls `arm()`
  and then an unawaited `tick()` regardless of which field changed or what it changed to. That fourth trigger is not a restatement of the first three: `arm()`
  alone is a no-op whenever a timer is already pending (`watchdog.service.ts`'s own guard, `if (this.timer !== null || this.inFlight !== null) return;`), which
  is exactly the state a watchdog already watching a crashed-but-disabled run sits in — so an operator flipping `enabled` back on in Settings for an
  already-crashed run would, without the kick, wait out the already-scheduled next tick (up to a full `tickMs`, a minute by default) before the sweeper acted,
  rather than see it act on the save itself. `tick()` is fired unawaited not because the spawn it may trigger is unimportant, but because this route's job is to
  persist a setting and report the state that follows from it — waiting for a live resume spawn, which depends on a third process (the dashboard), would give a
  settings save the latency profile of a dispatch for no benefit the response body would show. Firing it unconditionally, even immediately after `arm()` may
  have just started an identical chain, is safe rather than a double-sweep because `tick()`'s own in-flight guard returns the already-running sweep's promise
  instead of starting a second one.
- **Idle** — no run file anywhere says `running`; the timer is cleared. A run that finishes normally costs one extra tick, not a lifetime of them.
- **Off** — `BM_AGENTS` is off (nothing on this server can spawn, so there is nothing to watch for) or `BM_WATCHDOG=off` (the operator's kill switch, below) —
  no timer ever exists.

A standing `setInterval` was the obvious shape and is deliberately not what shipped. The requirement was that an idle watchdog cost nothing and be _observably_
idle, and a standing interval fails both halves: it would read every project's run directory once a minute forever on a machine where nothing has run in a
month, and a Settings State row fed by it could then only ever say "on," never "there is nothing to watch." A chain that exists only while there is something to
lose track of makes idle a checkable state rather than a claim — and the chain schedules its next link only after the current tick's own awaits resolve, never
on a bare wall-clock interval, so two ticks can never race the same crashed run for the same spawn.

A run started by typing the trigger with the board never opened for its whole life is never watched; CLAUDE.md already says to start runs from the board, and
this is one more reason.

### Grace: any attempt starts the clock, only a success counts

The sweeper's own per-run pass checks, in order, `exhausted` before grace, grace before spawn — and the rule that ordering encodes is: **any spawn attempt
starts the grace clock; only a success counts against the cap.** The two halves close two different failures. Grace applies to a failed attempt exactly as it
does to a successful one, because a dashboard that is unreachable or out of launch slots would otherwise be re-asked on every single tick for as long as it
stays down — a retry storm dressed up as monitoring. The cap counts successes only, because those same failures must not _burn_ it either: a dashboard down for
a day must not leave every crashed run marked `exhausted` without a single resume ever having actually started, or the one thing this feature exists to do would
silently never happen. `exhausted` is checked _before_ grace so a run that has used its last attempt reads exhausted on the very next tick, rather than making a
person wait out a whole grace window to be told nobody is coming. The floor on `graceMs` (five minutes) is not a conservative placeholder: the measured time for
a resumed session to reach its first heartbeat is ninety seconds on a good day (`run-20260903-112622`'s own resume — spawned 18:57:44, heartbeat 18:59:11), and
the incident this design responds to was itself an overload event, so a resume spawned into the same overload can take several minutes just to run its first
command.

### The Resume coupling: the board offers a hand resume exactly when the sweeper will not

This is the load-bearing rule of the whole feature, and for the length of one branch it was enforced by nothing but two comments.

Two spawns of `/backlog-orchestrate --resume` into one run is the failure it prevents. Nothing else prevents it. `AgentsService.resume()` refuses a _fresh_ run
— a run that is heartbeating — but says nothing about a second resume of a crashed one, which is the whole state this feature operates in; grace is a backoff
measured from the last spawn, not a lock, and it only exists inside the sweeper's own bookkeeping. Two concurrent `--resume` sessions each run `reconcile`, each
stage-write, and each merge, against one `run.json` whose single-writer guarantee (the first invariant in this file) assumes one process — and both end by
merging to `main`.

What keeps them apart is a coincidence of two rules stated in two places: design §6.1 says the board's crashed strip renders its Resume control only on
`watchdog.exhausted || !watchdog.enabled`, and design §2.2 says the sweeper's per-run pass returns without spawning on exactly those two conditions (steps 2 and
3). As shipped, those were two hand-written expressions in two files reviewed as two different tasks, plus prose. The whole-branch review measured what that was
worth: widening the strip's half to `canResume === true` left the whole suite green.

So the rule is now one function, `watchdogStoodDown` (`shared/agent.ts`), called by the client to decide whether to render the control and by
`watchdog.service.ts`'s `visit()` to decide whether to return without spawning. The client caller was `RunStrip.tsx`; task-37 deleted it, leaving the sweeper
the only caller for two merges, and task-38 restored it where §8.4.1 says it belongs: **`RunControls` (`client/src/components/RunControls.tsx`)**, drawn in the
Runs detail sheet's head. That component is also the Watchdog page's Resume (§8.4.2) — the same component rather than a second control agreeing with it, which
is why `WatchdogMonitor.tsx` does NOT call the predicate and must not start to: two surfaces, one caller. `test/watchdog-coupling.test.tsx`'s reader-list case
is what holds that, and it is written as an exact set precisely so a third caller cannot be added quietly. Its two inputs are single implementations for the
same reason. `WatchdogStateService.spawningEnabled(config)` is the one answer to "may the watchdog spawn" — it fills the wire's `RunWatchdog.enabled` AND is
what the sweeper's own gate calls, rather than the sweeper re-testing `config.enabled` under an env check made separately in `sweep()`; that was the second copy
of a vocabulary, and CLAUDE.md's `isAgentAction` invariant already says which copy goes stale. And `exhausted` is **derived**, never stored — see below.

Pinned by two suites and one table, because no single `it` can hold both halves (one needs jsdom and a React tree, the other a real Nest app):
`test/watchdog-coupling.test.tsx` drives the predicate against every row of `test/helpers/watchdog-coupling.ts`, renders `RunControls` for a crashed run in each
row's state and asserts the Resume appears on exactly that row's verdict, and pins WHO reads `watchdogStoodDown` as an exact set.
`test/watchdog-sweep.test.ts`'s own table case arranges the sweeper for the same rows and asserts it spawns iff the row does not stand down. Each row carries a
hand-checked `standsDown` literal rather than a derived one: without it, both halves would assert only that they agree with `watchdogStoodDown`, which a
`watchdogStoodDown` broken into a constant would also satisfy — the two sides would move together and stay "coupled" while saying something false. Sharing a
fixture across suites is against this repo's usual convention, and is the point here: two copies of the table would be two copies of the rule.

### `exhausted` is derived from `attempts` and `maxAttempts`, never stored

`entry.exhausted` used to be a boolean the sweeper set `true` once and never cleared, which `annotate()` then published verbatim onto every crashed run's
payload. The condition it stood for — `attempts >= maxAttempts` — was meanwhile re-derived by the sweeper from a config file it reads FRESH on every tick. Those
two disagree the moment `maxAttempts` moves, and moving it is not an exotic act: the strip prints "watchdog: exhausted after 1 — resume by hand", and Settings
has a control called "Give up after" three rows below the Activity list. Raise it, and from the next tick the sweeper falls through its stand-down and — once
grace from its own `lastSpawnAt` elapses — spawns again, while the payload still reports `exhausted: true` and the board therefore still renders the Resume
control and still prints "exhausted after 1". One click there is the second resume.

`watchdogExhausted(attempts, maxAttempts)` (`shared/agent.ts`) is now the one derivation, read by the sweeper's stand-down and by `annotate()`, which takes a
single `readWatchdogConfig()` read and fills `attempts`, `maxAttempts` and `exhausted` from it — so the boolean and the two numbers printed beside it can never
describe different moments. The generalisation is the part worth keeping: **a stored flag whose inputs are re-read on every tick is a second copy of the answer,
and it is the copy that goes stale.** This repo already answers that shape with derivation wherever it matters — "Groomed is derived … never stored",
"Board-versus-Archive is derived … never stored" — and this is the same rule, found the hard way inside a branch where no single task owned both sides of it.

What survives on the entry is `exhaustedLogged`, and it is strictly smaller than what it replaces: a guard for the once-per-condition `exhausted` event, which
only a per-entry flag can provide because the event log is a ring buffer that cannot answer "did I already say this" once fifty other lines have pushed it out.
The sweeper clears it again the tick the derivation reads false, so a run whose cap was raised and then spent again says so a second time rather than exhausting
in silence. It is a record of what was logged, never of what is true.

### A board resume is a spawn attempt: grace yes, cap no

`POST /api/agents/resume` with `origin: 'board'` spawns the same session through the same method as the sweeper's own resume, and used to leave no trace in
`WatchdogStateService` at all. The immediate consequence was reachable in one click: `AgentsController.resume` calls `arm()` right after a successful spawn,
`arm()` can drive a tick synchronously as far as its own grace check, and that tick found the same still-crashed run (a resumed session takes ~90 seconds to
reach its first `heartbeat`) with no entry, `lastSpawnAt === null`, and so spawned a second `--resume` of its own. The quieter consequence was that Settings'
Activity list — the answer to "where do I see that it ran" — silently omitted every resume a person started.

`WatchdogService.noteBoardResume(project, sessionId)` closes both. It is called from the controller, beside the `arm()` it must precede, and at controller level
for the same reason `arm()` is (RULING R3): `WatchdogService` injects `AgentsService`, so the reverse edge would be a cycle Nest cannot construct.

It stamps `lastSpawnAt` and pushes a `spawned` event; it deliberately does **not** increment `attempts`. Design §1 defines grace as "the interval after any
spawn attempt or failure during which the run is left alone", and a board resume is a spawn attempt by that definition — the same definition under which a
_refused_ watchdog spawn already stamps the clock. The cap is a different question with a different answer. §1's "Attempt — a resume spawn that returned a
session id" is written inside §2.2's per-tick loop, about the sweeper's own spawns, and reading it to include this one costs two things it never meant to spend:
`attempts` feeds the strip's "attempt 1/2" and "exhausted after N" sentences, which would then count spawns the watchdog never made; and — the real damage — the
Resume control renders precisely when the watchdog has stood down, so counting hand resumes would let a person walk a run's cap to `maxAttempts` using the only
control the board offers them, permanently retiring the automation on a run it may never have tried at all. Grace asks "is a resume session already on its way
into this run", which a board resume is; the cap asks "how many times has the watchdog tried on its own before asking a human", to which a board resume is the
answer, not an instance.

### In-memory state, and what a restart costs

Attempts, phase and the event log live only in `WatchdogStateService`'s memory (`server/src/orchestrator/watchdog-state.service.ts`), lost on every restart,
deliberately. The alternative — a durable attempt record beside `run.json` — was rejected because the whole run-file design exists to have exactly one writer in
that directory, and a second writer there, just to count "how many times has the watchdog tried this," would be a permanent structural exception for state that
does not need to survive a restart to do its job. The cost is bounded and named rather than hidden: a restart forgets every attempt already spent, so a crashed
run can receive up to `maxAttempts` _more_ spawns after one restart than the cap alone would otherwise allow. That is a bounded over-eagerness, not an unbounded
pile-up — the price of not teaching a second file how to survive concurrent writers.

### The settings-file exception, and why it is a directory mount

`~/.backlog-manager/settings/watchdog.json` (`server/src/orchestrator/watchdog-config.util.ts`) is the first file this server has ever written. Every other JSON
file it reads belongs to a skill's own CLI — `registry.json` to `backlog.mjs`, a project's `run.json` to `orchestrate.mjs` — and neither skill has anything to
say about how eagerly _this server_ watches for a crashed run, so there was no existing single-writer file for the setting to join. Env vars alone would have
worked too, at the cost of editing `.env` and restarting the container for every change; the user asked for Settings, which needs a file a server-side write can
actually reach. `docker-compose.yml` mounts `~/.backlog-manager` read-only for everything else and gains one nested mount, `~/.backlog-manager/settings`,
read-write. It is a mount of the _directory_, not of `watchdog.json` itself, for a mechanical reason: bind-mounting a path that does not yet exist on the host
creates a directory of that name, never a file — mounting the file directly would either fail on a fresh machine or silently create a directory where a file was
expected, either way.

One thing under `settings/` is now read by a skill's tool as well: `settings/orchestrator-control/`, the pause request (task-17, see "A pause request is a file
the server writes and the tool reads" above). It is still written only by this server — the exception is to the "nothing under here is ever read by a skill"
half of the sentence, not to the single-writer half.

Two switches guard this file's effect, and they answer different questions. `WatchdogConfig.enabled` (the file's own field, read fresh on every tick) is the
_user's_ switch: a disabled watchdog still arms, ticks and reports the crashed run it would have resumed — it only withholds the spawn, which is what keeps the
strip's "off — resume by hand" clause an honest fact rather than a guess produced by nothing watching at all. `BM_WATCHDOG=off` is the _operator's_ switch: no
timer, no reads, no spawn, full stop. It exists for one concrete, verified reason — the sweeper's boot-time scan reads `orchHome()`, which for any jest suite
that leaves `BM_ORCH_HOME` unset resolves to the developer's _real_ orchestrator directory. This was not a hypothetical: while implementing the sweeper, a read
of that real directory (read-only, no writes) turned up a live, currently-heartbeating run — `run-20260904-210004`, heartbeat 28 seconds old at the time, which
was the very run executing this feature's own implementation plan. Had `test/helpers/env.ts` not defaulted `BM_WATCHDOG=off` for every suite first, any test
that builds `AppModule` with `BM_AGENTS` on would have armed a live sweeper against that directory for the length of every `pnpm test` run — not a stubbed
spawn, a real `claude -p` session against the developer's own repository. The helper treats an _empty_ `BM_WATCHDOG` the same as absent (`||=`, not `??=`) for
the identical reason: a shell that exports `BM_WATCHDOG=` with nothing after the `=` is not "off" under `watchdogEnvOff`'s strict, trimmed comparison, and would
otherwise slip past the one guard meant to catch exactly that.

### The declined prevention layer

Two ways to stop the incident's mechanism at the source were offered and **declined for this round**: a plugin `Stop` hook that could refuse to let an
orchestrator session end its turn while its own run is `running`, and a `SKILL.md` rule banning `run_in_background` inside the orchestrator entirely. Either
would have kept `run-20260903-112622`'s own headless session from exiting mid-`sleep` in the first place. Declining them was a deliberate trade, not an
oversight: the sweeper covers the _outcome_ of a crash, not its cause, so the incident's exact mechanism can still recur — it is now bounded to roughly
`RUN_STALE_MS` (15 minutes) plus one `tickMs` of dead time plus one resume session's own context floor (~50k tokens, headless) per crash, rather than prevented
outright. Both declined layers stay on the table for a later round; this design's premise is that sweeping the outcome was enough to close the four-hour gap the
incident actually produced, without also having to get a hook or a skill-prose rule right on the first try.

### A crashed run renders as crashed, never as nothing

A crashed run renders as crashed, never as nothing. Supersedes the strip's old doctrine that a stale run must render nothing because its stage can't be trusted
— right about the stage, wrong that the whole strip had to go silent; a run sat crashed for four hours behind exactly that silence.

The surface states only facts the payload carries: heartbeat age, the _last reported_ stage (never claimed current), and the watchdog's own verdict
(`lib/run-watchdog.ts`'s `watchdogClause`). Badges, card run bars and `runClaimBlock` stay freshness-based — a crashed run does not stop being a live claim on
its item just because the board now says so out loud.

**Where that surface is, since task-38** (DESIGN.md §8.4.1's moved-rules table): the Runs page's **Live sheet row** — a `--red` dot, a `crashed` pill, and a
second amber line carrying all three readings at once (`no heartbeat for <age>`, then `last reported <id> at <stage>` or `all items at rest`, then
`watchdogClause`'s sentence). They travel together in ONE element (`runs-live-crashed-<runId>`) on purpose, and the suite asserts the line rather than three
nodes, because three independent assertions would let a later edit drop one of them silently and the row would then say less than the strip it replaces did. A
crashed run is a Live row and never a History one — a run reaches History when it has FINISHED, not when it has stopped reporting — and its detail sheet carries
the rest. The Board keeps its own reading: `RunChip` counts it (`1 run · crashed ›`).

**The Runs view says the same thing off the same payload** (bug-29): `mergeRuns` no longer filters the live map on `fresh`, so `MergedRun.live` is the DATA
authority ("does the payload have an entry at all") while `MergedRun.isLive` stays the PRESENTATION gate ("`fresh`") — since task-38 the only thing reading it
is the breathing dot, and nothing else does. Which SHEET a row is in is decided by `splitLive` on "does the payload still list this run as `running` or
`paused`", freshness deliberately excluded: gating that on `fresh` is what used to drop a crashed run into history among finished ones, where a reader scanning
for trouble does not look. It had to be split because the two fields answer different questions: `status` says whether the run is over, `fresh` says whether the
heartbeat is recent, and review or merge routinely outlast `RUN_STALE_MS` (57 gaps over 15 minutes across this machine's archived runs, worst two 249 and 206
minutes). Gating the data on `fresh` handed those windows to `useOrchestratorArchive`, which by design never polls, while the 5s live poll kept arriving and
being discarded — so the one surface built to watch a run happen froze until a reload.

Both status badges (the Runs row, the detail sheet's `status` fact) read `crashed` through `runStatusChip` (`lib/run-stage.ts`), the one implementation of that
substitution, derived from the live entry and never from `authority` — an archive record carries no `fresh` field and must keep printing its recorded status.
The DOT beside each reads `runDotTone` (same file), which is one function for the same reason: three surfaces draw it, and every finished run gets no tone at
all rather than a third colour, because a dot alone cannot tell `done`, `aborted` and `failed` apart and three shades of one dot is the encoding §5 rules out —
the WORD carries which ending it was.

`crashed` is **not** a sixth `RunStatus`: `RUN_STATUS_GLYPH`/`RUN_STATUS_CLASS` stay exhaustive over the five wire statuses, and the `runs` figure's own
five-status line still counts a crashed run under `running`, because that is a tally over the archived corpus rather than a claim about any run right now.

`useOrchestratorRuns` polls while any run is `running`, fresh or not. Widened from "any run is fresh" — a crashed run's attempt counter, error text and the
moment it goes fresh again would otherwise wait for a window focus, and the crashed row would read as a screenshot instead of something live.

#### Which object describes a run right now — the three tiers behind `pickAuthority`

`pickAuthority` (`client/src/lib/run-authority.ts`) is the ONE rule for "which object describes this run right now", shared by `RunsView.tsx`'s Live and History
rows and `RunDetail.tsx`'s detail sheet beside them. It exists because a whole-branch review found the two disagreeing about exactly that: a live-backed row
printed its merged/total and status off a minutes-stale archive snapshot while the detail pane beside it read the 5s live poll, and a run that had just finished
kept reporting `running` in the pane — elapsed time still climbing — because the pane fell back to that same stale snapshot the instant its `live` prop went
`null`, instead of using the run file it had _already re-fetched_ for exactly that transition. Both defects were one root cause wearing two faces: two call
sites each hand-rolling their own `??` chain, free to disagree about the order.

Up to three views of the same run can exist at once, in _decreasing_ order of freshness:

1. `live` — this run's entry from `useOrchestratorRuns`' 5s poll, present whenever the payload carries one at all. The endpoint re-reads each project's
   `run.json` per request, so an entry exists for as long as that file is the project's current run, whatever its status and however long ago it last stamped a
   heartbeat. The freshest thing either component can hold, by construction. This tier used to be built and documented as "present only while the server's
   `fresh` check says the process is still being heard from", which is what bug-29 removed: freshness is a separate field on the entry, and a `running` run in a
   long review or merge step routinely goes un-fresh while its file goes right on recording real stage stamps. Both callers now pass a possibly-stale entry here
   on purpose — `live` is the DATA authority ("what does the newest read of the file say"), and whether anyone is still hearing from the process is a separate,
   presentation-side question (`fresh`, `isCrashed`) that no caller asks this function to answer.
2. `fetched` — a full run file `RunDetail` fetched on demand (`fetchArchivedRun`) for the currently-selected run. It lands strictly _after_ whatever
   `useOrchestratorArchive` last held, being a fetch triggered by that selection and so always initiated later, which is why it is at least as fresh as the
   archive snapshot below whenever it exists. It is also the one thing that can ever correct a run whose live entry has gone away: an entry disappears once that
   run's `run.json` is no longer the project's current file (`init` archives it into `runs/` before writing the next run's), and a freshly re-read run file
   still tells the truth about it.
3. `archive` — `useOrchestratorArchive`'s own snapshot, fetched only on mount and window focus; see that hook's own doc comment for why it carries no poll of
   its own. This can be minutes stale for a run that is still moving, or for one that moved _and finished_ since the last fetch, which is exactly the case
   `fetched` exists to correct.

`RunsView`'s list rows have no `fetched` tier at all — fetching every row's full run file just to paint a list would be the "fattening the live poll" cost the
design doc's own API-shape decision rejected — so for them the rule collapses to `live ?? archive`. That is not a second rule; it is the same function with its
middle argument omitted, which is exactly why both callers reach for the one function rather than writing their own two- or three-argument `??` chain. A reader
changing the precedence has one function to change, not one function to find and one more to remember exists.

## Queue wait is not work

`itemDurationMs` (`client/src/lib/run-time.ts`) is the one implementation of "how long did this item take." It measures from an item's first non-`pending`
`stageAt` arrival — `preflight` counts, because the gate check is the orchestrator doing work on this item; only `pending`, the interval where nothing is
happening to the item at all, is dropped — to its terminal stamp, or to `now` while the item is still moving. Every surface that prints that reading calls it
rather than deriving its own: the run drawer's row and the Runs section's detail-pane row, through the shared `RowTime`
(`client/src/components/board/RunRowTime.tsx`), and `aggregateRuns`' `avgItemWorkMs` (`client/src/lib/run-stats.ts`), which averages it over every merged item.
Nothing else in this codebase reads it.

`run-stats.ts` used to carry a second implementation of the same question, answering it by spanning an item's literal first recorded stamp to its last —
`pending` included. The two silently disagreed on a real run (`run-20260901-112815`): bug-7 read as 161 minutes of "how long did this item take" under that
first-to-last reading and 25 minutes under `itemDurationMs` — the other 136 minutes were the four items ahead of it in the queue being worked while bug-7 waited
its turn, not anything that happened to bug-7 itself. A queue worked one item at a time will always produce this gap for whichever item sits further back in it;
folding queue wait back into a duration reading is exactly the bug this invariant exists to keep from recurring. The excluded interval is not thrown away —
`itemQueueWaitMs` (same file) gives it its own reading, printed by the Runs pane as context beside the head time — but it is never added back into any "how long
did this take" total anywhere in this codebase.

Machine time makes the identical exclusion one level up, for the identical reason. `runStageTotals` (`client/src/lib/run-stats.ts`) — the "where did the time
go" rollup behind `StageBars` — sums every item's per-stage spans against `MACHINE_STAGES`, the closed list of the seven stages that are the orchestrator
actually working, and `pending` is not on it: summing every item's queue wait into a run's own "machine time" would report however many run-lengths of pure
nothing on top of whatever the run actually did — the run-level version of the same mistake `itemDurationMs` exists to prevent at the item level.

A new surface that needs to answer "how long did this item take" imports `itemDurationMs` and reads its result rather than subtracting `stageAt` stamps itself.
That is not a style preference: it is the only way the drawer, the Runs pane, and any surface built after them are guaranteed to agree with each other, the same
guarantee `RowTime`'s move out of the run drawer and into a shared component exists to make structural rather than coincidental.

### `stageAt` records first arrivals only, and what that costs the stage rollups

`orchestrate.mjs` guards its `stageAt` write with `if (!(stage in item.stageAt))`, so each stage records its FIRST arrival and nothing else. The field's own doc
comment on `RunQueueItem.stageAt` (`shared/types.ts`) states this where the shape is declared; it is restated here because `itemStageSpans` is where it actually
bites. A fix-and-re-review loop's second or third pass through `reviewing`/`fixing` therefore never gets a stamp of its own. That time does not vanish from
`itemStageSpans`' spans: it folds into whichever span was open when the loop happened — the span belonging to whatever stage's stamp is chronologically just
before the NEXT stage the item reached for the first time. A `reviewing` → `fixing` → `reviewing` → `merged` item reports one `reviewing` span running from the
first `reviewing` arrival to `merged`'s arrival; the second trip is real time spent and is indistinguishable from time spent on the first pass.

This is the accepted cost of keeping `stageAt` a shape record rather than a full event log, and it is why the design doc rejected a gantt or timeline rendering
of this data by name. A per-item stage bar still earns its place, because "which stage ate the most wall time" survives the blur; a timeline would present the
folded span as one uninterrupted visit, which is the misleading reading. What the blur does NOT license is double-counting — folding an interval into two
numbers that later get summed is an arithmetic error, not a blur, and the two corrections below exist to keep that distinction.

### The two corrections inside `runStageTotals`

Both were found in review rounds after the function first shipped, and both concern the OPEN span it adds for a still-live item on top of `itemStageSpans`'
completed ones.

**The open span is gated on the RUN, not the item.** For a run that has stopped — `done`/`aborted`/`failed` — whatever stage an item was frozen in is not "still
happening"; it is the last thing that happened before nobody was watching. Crediting `now − stamp` to an aborted run's stranded `fixing` item adds however long
it has been since the abort, however stale the archive is when read. That single unbounded number does not misreport one stage only: `StageBars` sums
`runStageTotals` across every run in a selected range, so one dead item's ever-growing span keeps inflating a range total that should be fixed forever once
every run in it has stopped, and the per-run bar — which scales each segment to the largest value in the set — flattens every real stage into a sliver beside
it. The spec's reasoning for the open span ("so the row for the stage it is in grows as the pane ticks") is about a live run specifically; an archived stopped
run was an omission in that reasoning rather than something it argued for. `status` is a REQUIRED field of the parameter rather than optional with a default,
because every real caller has it on hand — `RunDetail`'s resolved `source` and Task 7's `pickAuthority(...)` result both carry a `status` — and an optional
field is exactly the gap a future caller falls through silently, passing archived data without its `status` and resolving to whatever the default happened to be
instead of failing to compile.

**`status === 'running'` is not sufficient on its own, because a crashed run keeps it forever.** `init` refuses to overwrite a run file already at that status,
fresh or stale — recovery is `--resume`/`--abort` only, per "One run per project, checked twice" — so `status` alone cannot separate a run being worked from one
whose process died days ago. `GET /api/orchestrator/archive` serves that frozen file verbatim, reaching this function through the one door the `status` gate
left open, and via `sumStageTotals` the wide tile summing every run in scope. When this was found the LIVE path could not reach that door, because `RunsView`'s
merge dropped un-fresh entries and `pickAuthority` could never pick one; bug-29 removed that filter, so a stale-but-arriving live entry is now exactly what this
function receives during a long review or merge. That changed nothing about the fix and everything about how load-bearing it is — the door is now the main one
rather than a side entrance.

The fix mirrors `runElapsedMs` (`run-time.ts`), which forks on the same distinction for the live board. This function cannot read the same `fresh` flag —
`OrchestratorArchiveRun` carries no `fresh` field at all, live-backed or archived — so freshness is DERIVED here, by the same `RUN_STALE_MS` heartbeat check the
server performs once for the live payload, measured directly against `updatedAt`. While fresh the open span still ends at `now`; once stale it ends at
`updatedAt`, frozen at the run's own last confirmed heartbeat rather than at whatever instant the archive happened to be read.

**The open span's START is corrected too, and this is the double-count case.** `stageAt[item.stage]` is a first arrival, so an item that re-entered its current
stage after a fix loop has a current-stage stamp that is STALE. An item that went `reviewing` → `fixing` → back to `reviewing` has no fresh `stageAt.reviewing`
key for the second visit, so that stamp points at the first visit, which precedes a LATER stamp (`fixing`'s own arrival) already recorded on the item. Opening
the span there would credit the whole interval from the first `reviewing` arrival to `now`, and the first-arrival-to-`fixing` portion is ALREADY counted once as
the closed `reviewing` span `itemStageSpans` produces from those same two stamps. The span therefore opens at
`max(the item's own latest parseable arrival across every stamp it has, stageAt[item.stage])`. For an item that never re-entered its current stage that max is a
no-op, because the current stage's arrival already IS the latest stamp, so no existing case's numbers move; for a re-entered stage it resolves to the later
stamp the item picked up on its way through the loop, which is exactly where the closed span stopped counting, leaving the open span measuring only the
genuinely uncounted tail.

An `updatedAt` that will not parse is treated as NOT fresh — an unparseable heartbeat is not evidence a process is alive — but it also leaves no honest instant
to freeze the span at, so such an item's open span contributes nothing at all beyond its already-summed closed spans. That is this module's "skip rather than
fabricate" rule, not either extreme a less careful reading reaches for: crediting `now` anyway silently un-fixes the bug, and throwing fails on exactly the
hand-editable input the module exists to survive.

**The terminal-stage filter is a guarantee, not a redundancy.** A span labelled by a terminal stage (`merged`, `parked`, …) is dropped by the same
`MACHINE_STAGES.includes(span.stage)` filter that drops `pending`, and a reader who believes the weaker claim could delete it. What is true, but only of files
the orchestrator itself writes, is that a terminal arrival is the last recorded stamp and `itemStageSpans` opens no span from the last stamp — an ordering
convention, not a structural invariant. `parsedArrivals` sorts by TIME, and a hand-edited or corrupt file is the input this module exists to survive, so a
terminal stamp that is not chronologically last WILL open a span and the filter is what stops it counting. The open-span step is guarded separately, by
`isTerminalStage`.

## A session's cost is recorded per transcript, and a transcript's identity is its file name

A session's cost is recorded per transcript, and a transcript's identity is its file name, not its session id (task-27).
`orchestrate.mjs usage <id> --jsonl <file>` is the one writer of `RunQueueItem.usage`, called at inspect time (SKILL.md §5, on `stage <id> inspecting`'s own
Bash invocation, so it costs the driver no turn) and again per retry or fix-loop transcript; `references/recovery.md` has a resumed driver pick up whatever the
crashed one missed.

One entry per transcript, never one summed figure — "the fix loop cost more than the item did" is a question an early fold destroys.

The identity rule is the trap: `claude -p --resume` keeps the session id it was handed, so an item's `<id>.jsonl` and its `<id>-fix-1.jsonl` report the SAME
session (verified against this machine's `task-22` pair), and keying idempotency on `sessionId` — which this task's own plan called for — would make a fix
loop's entry overwrite the execute session's. Identity is `kind` + `loop`, both derived from the file name the caller passed and neither guessable from content,
which also makes re-running the command over an already-recorded transcript harmless.

**Absence is a value here, at three levels**: no result event in the transcript writes no entry at all (a killed session was not free, and exits `0` saying so);
a numeric field a future CLI renames reads `null`, never `0`; and `usage` is optional on the queue item, so a run archived before this landed reads `null` from
`runUsageTotals`/`itemUsageTotals` (`client/src/lib/run-stats.ts`) and renders nothing at all rather than `$0.00`.

That is why nothing on the path from run file to view defaults it to `[]` — `RunDetail`'s row mapper passes it through undefaulted where it defaults
`assumptions`, deliberately.

**Where the reading shows up** — unchanged in WHAT is shown, and renamed by task-38 only because the surfaces were: the **History row** (`wall · $`), the detail
sheet's **facts strip** (`$ · turns · sessions`, its own `cost` cell), and each item's own usage line. The row prints cost alone because it has one slot's worth
of room and "what did it cost" is what a list is scanned for; turns and sessions are in the sheet, per run and per item.

## Board-versus-Archive is derived, and "last touched" has three rungs

Board-versus-Archive is derived from `updated ?? lastCommit ?? created` and the run payload, never stored. `isStale`/`leavesBoard`
(`client/src/lib/item-stale.ts`) are the one implementation, read by both BoardView and ArchiveView, so an item can never be in both surfaces or neither;
`lastTouched` (`client/src/lib/item-touched.ts`) is the one implementation of the three-rung precedence, read by `isStale` and by Archive's month grouping so a
column can never be ordered by a date nobody used to decide its contents.

Five rules the predicate encodes and no caller may re-decide: an item **in progress** is never stale (`started` outranks the arithmetic); an item a **fresh
orchestrator run holds** is never stale either, which is why both functions take `runs` — required, no `[]` default, because a default is what lets the next
caller reintroduce bug-11 silently (`runHoldsItem`, `shared/agent.ts`, is every stage but the five true exits, so `pending` and `parked` both count, and it is a
separate function from `runClaimBlock` because a parked item must stay on the Board _and_ stay hand-dispatchable); a **done or rejected** item is never stale
(staleness is about neglected work, and a done item is only reachable through the Board's own Done filter); an **unparseable or absent** pair of stamps reads as
fresh, because a malformed file has to stay where someone will see it; and a **task never leaves the Board**, it gains a `stale` marker instead.

The second rule exists because the item file cannot know: a run stamps `started:`/`phase:` on its own worktree's copy, so the copy the registry points at is
silent for the whole run — the same reason `runClaimBlock` exists, and `ATTENTION_RUN_STAGES` moved to `shared/types.ts` (beside `RUN_CLAIMED_STAGES`) so a
`lib/` module could read it without importing a React component.

The window is a client setting (`staleDays`, default 30) — a view decision over a corpus the server already returns whole — and it is the one numeric setting
whose clamp falls back to the DEFAULT rather than the nearest bound below `min`, because `0` would silently empty three columns.

### The middle rung comes from git, not the item file

The middle rung of "last touched" comes from git, not the item file. `updated:` has exactly one writer (`backlog.mjs start`/`stop`) while the item file has
several editors, so a groom session that writes Cause and Fix through the editor without `start --as groom` leaves the frontmatter silent — and ixray's bug-7
aged off the Board on a five-week-old `created:` five days after it was groomed.

`lastCommit` (`server/src/items/git-dates.util.ts`) is the committer date of the last commit touching the file, read once per scan with
`git log --name-only --relative`, keyed relative to the _project_ path because a registered directory need not be a repo root. Every failure — no git, no repo,
untracked file, timeout — degrades to `created`, never throws: an unreadable history must not 500 every project's board.

**The container needs `git` installed and `safe.directory` in system config** (Dockerfile); without either the degrade path is silent and the fix is host-only,
which is how it first shipped invisible.

The result is memoised per project against the mtimes of `index` and `logs/HEAD` — the one cache in `items/`, and it is a memo rather than the stale cache
`ItemsService` refuses because it is keyed on the files git rewrites whenever the answer can change; with neither file present there is no key that can move and
it recomputes instead. It exists because the call costs 84–396ms per project and `scanProject` runs on both `/api/items` and `/api/projects`.

## A project's source is a committed marker, resolved per request, and an unsupported one never falls back to files

Every registered project's items used to be, by definition, the files under its `backlog/`. Phase 1 of the tracker-backed design (task-43,
[spec](../superpowers/specs/2026-09-17-tracker-backed-backlog-design.md) §3–§4) makes that a question the server asks rather than an assumption it holds:
`resolveSource` (`server/src/items/sources/resolve.util.ts`) reads the project's own `backlog/source.json` and answers `missing`, `files`, `tracker` or
`unsupported`, and `ItemsService` dispatches over the adapters registered under `ITEM_SOURCES`. Phase 1 registered exactly one adapter — `FilesSource`, a wrapper around the same
`scanProject` — so every project on every machine resolved to `files` and the payloads were what they always were plus one `source` field each. That was the
point: the seam was the change, and a payload diff of exactly those fields is what proved it. Phase 2 (task-45) registered `GithubSource` beside it by appending
two lines to `items.module.ts`, and `items.service.ts`'s listing control flow did not change — the claim, tested.

**The marker is per project and committed**, not a per-machine setting, because source is a property of the PROJECT and not of the laptop reading it (spec
§2.3). A per-machine setting would have to be set again on every clone, and the first machine that had not heard of the tracker would render the repo's stale
item files as though they were the backlog. Committing it means every clone agrees about who owns the items, and a fresh checkout is correct before anyone
configures anything. It lives under `backlog/` rather than at the repo root so that `backlog.mjs root`, the `missing` check and every "where is this project's
backlog" answer keep one home.

**It is read per request and cached nowhere** — one `existsSync`, one `readFileSync`, one `JSON.parse` — which is deliberately the same rule and the same cost
class as the registry read one module over. The events that change the answer (someone connected a project, someone edited the file) are exactly the events
that change the registry, so a cache here would go stale on the same events, and it would buy microseconds against a scan that is about to read hundreds of
files anyway.

**`unsupported` never falls back to `files`.** This is the negative the whole seam rests on, and it is the one a later reader has a plausible reason to
reverse — "we could not read the marker, so show what is on disk" sounds like graceful degradation. It is not. A project connected to a tracker still has its
old item files sitting in every clone, and a build that cannot honour the marker would render those files as ghosts beside the real items on another machine's
board — two boards disagreeing about what is open, with nothing on either saying which is wrong. So an unsupported project contributes no items at all, its
`/api/projects` row reads `source: 'unsupported'` with all-zero counts, and the reason travels once in `ItemsIndex.errors`, prefixed with the marker's absolute
path the way a scan error is prefixed with the item file's. `missing` keeps its old meaning exactly — no `backlog/` directory at all — so an unsupported
project is `missing: false` and a storeless one is `missing: true` with `source: null`. An explicit `{"kind":"files"}` IS honoured: writing the default down
must not be a way to opt out of it, and `files` never has to be registered for that to work.

**`ItemsService` refuses two adapters of one kind at boot**, with the duplicated kind in the message, rather than letting the last one win. The loser would
answer nothing, and a board that renders one source's items while another's never appear is wrong without ever saying so; a provider that throws turns that
into a stack trace at startup.

`SourceKind` is the closed list of adapters THIS BUILD ships — `'files'` alone in phase 1, `'files' | 'github'` since task-45 registered the second one — and it
widens in the same commit that registers the next adapter, never ahead of one. A kind named in the type with no adapter behind it would be a lie the resolver
could not keep. `BacklogItem.source` is required rather than optional for the same
reason `SectionCounts` spells out every section: the shape stays total, so every fixture literal in `test/` has to name its source and the compiler is the
checklist.

## The Orchestrate sheet's uncommitted flag is read from git per request and memoised nowhere

`GET /api/items/uncommitted` (`server/src/items/uncommitted.util.ts`, `ItemsService.uncommitted`, `ItemsController.uncommitted`) answers which of one project's
item files a board-started orchestrator run would not be able to see, and the Orchestrate sheet's step 1 renders that as a chip, a count in the run's own words
and a `deselect uncommitted (N)` button. This section is the "why" behind five decisions in it, four of which a later reader has a visible, plausible reason to
reverse.

### The gap it closes

The sheet's queue preview is a pure derivation over the board's own item scan, which reads the **working tree**. The run that follows gates every item at
`<base>` — `BASE_REF_DEFAULT` in `orchestrate.mjs`, i.e. `main`, and the board never passes `--base`, so `main` is the ref for every board-started run there
will ever be. Those two readings disagree whenever the file on disk is not the file at `main` — which is broader than one situation, and the breadth is
deliberate (see "one question, two fates" below). In the shape that prompted the task, the sheet previews a ready bug, `buildGatedQueue` reports
`not committed on main — the worktree this run creates from main would not contain <path>`, and the item is skipped — after the person has walked away from a
multi-hour unattended operation. The 2026-09-06 cross-run sweep counted five such skips across three projects (bug-12 twice in backlog-manager, bug-13 and bug-7
in claude-agents-dashboard, bug-16 in ixray). task-29 closes the other half of this at groom time, said by the skill that creates the state; this one is for the
person who groomed yesterday and is launching today.

### One question, two fates — and why the sheet has to say both

The predicate is "does the working copy differ from `main`". The run's `not committed on main` verdict is strictly narrower: `readBlob(relPath) === null` in
`buildGatedQueue`, i.e. the path is **absent** from `main`. So a flagged row has one of two futures, and they are not the same news:

- **Absent from `main`.** The run refuses it with that verdict and moves on. One gate verdict spent, no dispatch, no worktree; the cost is the run slot and a
  second trip for whoever queued it.
- **Present at `main`, edited since.** The run gates `main`'s copy and then **executes `main`'s bytes**. It may read `ungroomed` there — the sibling case
  `buildGatedQueue`'s own comment describes, an item committed while ungroomed and groomed only on disk — or it may gate `ready` and simply run the OLDER plan.
  Either way the work the person just wrote is not the work that happens, and no verdict in the run file records that, which arguably makes this the worse of
  the two.

Review round 1 of task-32 caught the sheet's note asserting the first fate of both rows ("its gate will report 'not committed on main' and skip them"), which is
false for the second and reachable by any working-tree touch of an already-groomed, already-committed item — `backlog.mjs start --as groom`'s own `updated:`
stamp included. It is the predictable mistake, because only the narrow shape has a quotable verdict string, and quoting the run verbatim is one of the feature's
own goals. **Any surface that states a consequence of this flag must split it**, and the resolution is what the note does now: lead with the fact true of every
flagged row (the run reads `main`'s copy, not the file on screen), then name both fates, keeping the literal `not committed on main` on screen but attached to
the case it describes.

The chip word stays the single term `uncommitted` across the chip, the `deselect uncommitted (N)` button, the endpoint and these docs, even though a
tracked-and-modified row is one whose _changes_ are uncommitted rather than the item. One vocabulary beats per-row precision here because the note directly
above the rows now defines the term outright; a chip reading `differs from main` would be more precise about one row and would leave the button and the endpoint
speaking a different language from it.

### 1. No memo — and specifically not the one in the next file over

`lastCommitDates` (`git-dates.util.ts`) sits beside this, does an almost-identical thing (spawn git, read something about `backlog/`), and is memoised. Copying
that memo here would be wrong in the worst available way: its key is the mtimes of `.git/index` and `.git/logs/HEAD` — the files git rewrites whenever the
answer to _its_ question, "when was this file last committed", can change. Editing an item file in the working tree, which is the precise event this module
exists to report, moves **neither** of them. A memo on that key would therefore answer "clean" forever after its first hit, reintroducing the exact false
negative the feature was built to remove, and it would do so silently — the sheet would simply stop flagging, which looks identical to a project with nothing to
flag.

The cost is affordable without one. Measured 2026-09-07 across the five projects in this machine's registry, both spawns together took 50–270ms per project —
and unlike `lastCommitDates`, which runs for **every** registered project on both `/api/items` and `/api/projects` (the two the board fetches on mount and on
every window focus), this runs for **one** project **once per sheet open**. That asymmetry is the whole reason one of these two functions needs a cache and the
other must not have one. The client half enforces the cadence too: the effect is keyed on `[project]` alone, so walking the three steps or flipping a picker
re-asks nothing.

**A sibling endpoint, not a `BacklogItem` field**, for `merge-check`'s reason: a field would put an un-memoisable git read inside `scanProject`, which runs for
every registered project on both `/api/items` and `/api/projects`.

### 2. `main`, not `HEAD`

`git status --porcelain` is the obvious implementation and the wrong one. It compares against `HEAD`, which is the right ref only while the main tree happens to
be sitting on `main` — and an item committed on a branch that `main` does not contain is _precisely_ one of the cases that gets skipped, which `status` reports
as a perfectly clean tree. `test/uncommitted.test.ts` case 4 asserts both halves of that: the util reports the file, and `status --porcelain` prints nothing.

Diffing against `main` also covers the sibling case `buildGatedQueue`'s own comment describes without a second question. An item committed while ungroomed and
groomed only in the working copy _is_ present at `main`, so it never earns the "not committed" verdict — the run gates the stale bytes and reports plain
`ungroomed`. It differs from `main`, so this flags it. Note that this paragraph and the sheet's own note are the two halves review round 1 found contradicting
each other: the plan said here that a present item never earns the "not committed" reason, and then wrote a note claiming exactly that reason for every flagged
row. The sentence that is true of all of them is the one the note now leads with — the run reads `main`'s copy rather than the file on screen — and the fates
are split after it (see "One question, two fates" above).

### 3. Two git reads, and the asymmetry between them

`git diff --name-only --no-renames main -- backlog` finds tracked files whose working-tree content differs from `main`. It cannot find a file git has never
tracked — and a brand-new, never-committed item file is exactly that, which is the single most common shape of this failure.
`git ls-files --others --exclude-standard -- backlog` is the second read, and it is not belt and braces: verified 2026-09-07 against this machine's `ixray`, the
diff printed nothing and `ls-files --others` printed `backlog/bugs/open/bug-16-….md`, one of the five items the sweep had recorded as skipped. Case 3 in the
suite asserts the util's answer **and** that the diff-only answer is empty, so a later "simplification" down to one spawn cannot leave the case green.

A failure of _either_ read fails the whole question (`known: false`). Reporting the half that worked would be a confident, incomplete statement of fact about
someone's repository, which is the one thing this render must never be.

### 4. Both preconditions mirror `blobReaderAt`, and `known: false` is why

The util refuses to answer when the project path is not the repo toplevel, or when `main` does not resolve to a commit. Those are not arbitrary safety rails —
they are `blobReaderAt`'s own two preconditions (`orchestrate.mjs`), and at that seam the tool has **no blob view at all** and gates the working copy instead.
So there is no divergence to warn about, and a chip there would be a false positive against a run that is going to read exactly the bytes the board is showing.

`known` is a separate field rather than an empty list because the client has to tell "nothing to flag" from "no idea", and only one of those two may ever become
a rendered assertion. It is also why `fetchUncommitted` (`client/src/lib/agents.ts`) shape-guards the body and **throws** on a malformed 200 rather than passing
it through: `known` cannot carry that load on its own, since `undefined` is falsy and a body missing `paths` would happen to suppress the chip today while
silently asserting the opposite the day someone writes the render guard as `known !== false`. Guard, throw, `.catch` — one path for "no answer", the same
posture the merge-check hint already takes.

### 5. The default selection is not changed, and that is the feature

The original idea asked for uncommitted rows to be excluded from the default selection. That is refused. `selected === null` in `OrchestrateSheet` is the
difference between two different INSTRUCTIONS — "drain the queue" and "run exactly these ids" — and auto-exclusion would force an explicit `ids` list into every
launch that has one flagged row. Two costs follow. The queue snapshot freezes: an item committed while the sheet sat open would be dropped from a run the person
believes is draining everything. And the board would be overruling the orchestrator's own gate on the strength of a preview that says outright it is not
authoritative — the same reasoning `emptySelection`'s comment already gives for not refusing an empty queue.

It also buys almost nothing. The run skips a flagged item at the cost of one gate verdict: no dispatch, no worktree, no session. What the person actually lacked
was the information, so they get the chip, the run's own verdict string verbatim, and a `deselect uncommitted (N)` button that narrows the selection the same
way unticking the rows by hand does. The person's act, not the sheet's. `test/orchestrate-uncommitted.test.tsx` case 18 pins it as an assertion about the ABSENT
`ids` key, not about its value.

### What deliberately does not read this

It is a launch-time fact about a ref, not a lifecycle state. `isStale`, `leavesBoard`, `lastTouched`, `deriveGroomed` and `runClaimBlock` are all untouched; no
Board card renders it; it reaches no persisted setting and no run file. A chip on every card would also fire during ordinary grooming, when "you have not
committed this yet" is not news — the sheet is the one place where not knowing costs a run slot. Step 2 of the sheet carries no chip either, and that is a
decision rather than an omission: the flag is a step 1 fact about membership, and step 1 is where the control that acts on it lives.

## Every skill CLI exits through `process.exitCode`, never `process.exit()`

`process.exit()` in an entry guard is not a neutral way of spelling "return this code". Writing to a **pipe** is asynchronous on POSIX, so `process.exit()`
tears the process down before stdout has drained and everything past the 64KB pipe buffer is dropped — silently, with a zero exit status and no error anywhere.

This shipped. A real `retro.mjs sweep --json` of this machine is 442,757 bytes; through `| jq` it arrived as **exactly 65,536 bytes** and a parse error, while
`> file.json` — a redirect to a file, which is a synchronous write — was perfectly fine every time. That asymmetry is the whole reason it survived: the hand
checks that a human runs all redirect to a file or read a small fixture, and both of those are green against the bug. `retro.mjs` was fixed the afternoon it was
found; ref-3 asked whether the other two tools had the same defect, and task-34 (2026-09-13) confirmed they did and closed it.

Setting `process.exitCode` instead lets node finish flushing and exit on its own. Nothing about the exit code changes: every command path in both tools returns
an integer, and `process.exitCode = undefined` and `process.exit(undefined)` both exit `0`, so even a path that returned nothing behaves identically.

### Why "exit naturally" is not a hang waiting to happen

What `process.exit()` bought was a forced teardown even if something _were_ holding the event loop open. Measured against both files as they stand:

- **`backlog.mjs` holds nothing open.** Every read is synchronous `fs`. No timer, no child process, no server, no stdin read.
- **`orchestrate.mjs` holds nothing open either, despite looking like it might** — this was ref-3's one genuinely open question. Every child process is
  `spawnSync`, reaped before the call returns, and `watch`'s polling sleep is `sleepSync`: an `Atomics.wait` on a throwaway `SharedArrayBuffer`, which _blocks
  the thread_ rather than scheduling a timer. There is no `setTimeout`, no `setInterval`, no `async`/`await`, no server and no stdin read in the file, so
  `watch` and `verify` — the two commands ref-3 flagged — leave no live handle when `main` returns. Neither tool needs an explicit drain.
- **`api-call.mjs` (task-47) is the fourth file the guard reads, and the reason `orchestrate.mjs` can still say the above.** A tracker project needs `fetch`,
  which is asynchronous, so the asynchrony is exiled into a CHILD process that `orchestrate.mjs` runs with `spawnSync` and reaps before its own call returns.
  The parent stays synchronous by construction rather than by argument. The child itself takes the awaited entry shape, on its own safety argument: exactly one
  `fetch`, awaited to completion, `connection: close`, no timer, no server and no child of its own. The title of this section says "every" rather than "all
  three" for that reason — the rule was never about a count, and `backlog.test.mjs`'s `CLI_SOURCES` is where the list lives.

So the trade is real but narrow: a future edit that opens a timer, a server or an async child would hang instead of being killed. **The rule for whoever makes
that edit is to close the handle — not to bring `process.exit()` back**, which would restore the truncation along with it.

### How it is pinned

Three cases, because each covers something the others cannot:

- One behaviour test per tool, each driving the real CLI through `spawnSync` (a real pipe) with a fixture deliberately larger than 65,536 bytes:
  `backlog.test.mjs`'s `board --json` over 250 seeded items, and `orchestrate.test.mjs`'s `status --json` over a 250-item committed queue. Both assert the
  measured byte count, not just that the JSON parses — a fixture that lands under the buffer is vacuous, and a test that redirected to a file could not fail on
  this bug at all. Both were observed red at exactly 65,536 bytes before the fix.
- A source guard in `backlog.test.mjs` reading all three tools as text (`backlog.mjs`, `orchestrate.mjs`, `retro.mjs`), asserting each sets
  `process.exitCode = main(` and that no non-comment line calls `process.exit(`. It lives beside the other cross-skill cases in that suite, for the same reason
  they do: the rule spans three skills and a suite reading one half cannot catch the halves drifting. It is also the only one of the three that covers a CLI or
  an entry point nobody has written yet. Comment lines are stripped before matching because `retro.mjs`'s own note quotes the literal `process.exit()` twice
  while being the correct file.

## This file stays one document (decided 2026-09-12, task-33)

The question task-33 deferred to the end of its pass: now that df008f8 gave **every** `CLAUDE.md` invariant a long-form home here and d7463d2 cut `CLAUDE.md`
down to a normative index plus anchored `Why:` links, should this file split into one document per invariant — or per subsystem?

**No. It stays one document.** Four reasons, in the order they weighed:

- **The whole link surface is `CLAUDE.md`, the one file no session can avoid reading.** Measured on 2026-09-12: 45 anchored `invariants.md#…` references, 43 of
  them distinct, and _every one of them_ lives in `CLAUDE.md` — no other doc, skill or agent links into this file by anchor at all. A split rewrites all 45 in
  the file that is auto-loaded into every session and every headless orchestrator run in this repo, so a botched target is not a dead link somebody finds later,
  it is auto-loaded breakage. The concentration cuts both ways and it is the reason to be conservative: one file to edit means the split is _mechanically_ easy,
  which is exactly how it would be done carelessly.

- **This file is addressed by section already, and nothing loads it whole.** It is 2,759 lines and ~170 KB, and that number is what makes a split _sound_
  obvious. But it is never auto-loaded — it is reached by following one anchor, and a reader who follows one anchor reads one `##` section. Splitting buys file
  granularity over a document that already has heading granularity. The size argument would become real the day something routinely reads the file end to end;
  today nothing does.

- **Several sections are only correct as a pair, and a split puts the pairs in different files.** The three-layer resume and the sweeper's prune keep-set; merge
  mode and `branched` as its sibling exit; the uncommitted read and board-versus-archive staleness, which share a `runs` argument and a "no default" rule. Each
  pair is one fact told from two sides, and "one home per fact" is the rule this whole directory exists to serve. A reader who has both halves in one scroll
  catches them drifting apart; a reader who has to open a second file does not.

- **Symmetry with the subsystem docs is not a reason.** `api.md`, `board.md` and `skills.md` are each one subsystem's map. This file is the reasoning behind
  rules that cut _across_ all three — the single-writer relationships alone span the server, the client and three CLIs — so there is no per-subsystem seam to
  split it on that would not put one rule's rationale in two places.

**Ordering against
[idea-11](../../backlog/ideas/done/idea-11-path-scoped-claude-rules-pointers-into-the-invariant-rationale-once-headless-loading-is-proven.md), stated so it is
not rediscovered** — since built, as task-35, against exactly these anchors; see
[the probe matrix](#path-scoped-clauderules-reach-a-headless-run-in-a-linked-worktree-task-35). idea-11 proposes `.claude/rules/*.md` pointers whose payload is
"read `invariants.md` §A, §B, §C" — they consume this document's anchor shape, so a split after they exist rewrites every one of them on top of every `Why:`
pointer in `CLAUDE.md` (a set that grows with each rule — it was 45 when this was decided and 47 by bug-33, which is exactly why the argument is stated as
"every one of them" rather than as a number). This decision therefore had to be made first, and it is now made: **idea-11 may be built against the current
anchors.** It has been: the four pointer files under `.claude/rules/` cite 34 of them. If a split is ever reopened it has to land _before_ those pointers, not
after — which now means rewriting those four files as well as every `Why:` line in CLAUDE.md.

**What would reopen it**, stated concretely rather than as "if it gets too big": something other than a human or an anchor-following agent starts reading this
file end to end on a routine path — a rules loader, a retrieval step, a skill that `cat`s it (the `.claude/rules/` pointers are not that: they carry anchors,
and the loader injects the 12-to-16-line pointer file, never this one) — at which point the 170 KB stops being inert and the per-section split earns its
rewrite. Absent that, growth alone does not.

## Path-scoped `.claude/rules` reach a headless run in a linked worktree (task-35)

Every file under `.claude/rules/` carries a `paths:` glob and is a **pointer** — one line per anchor into this file, never a second copy of the reasoning. Both
halves are load-bearing, and both were measured rather than assumed.

**Why `paths:` is mandatory.** A rule file with no frontmatter is loaded at `session_start`, in _every_ session, whether or not it is relevant — a permanent
context-floor increase on all of them. That is exactly what the pointers must not cost, so an always-loaded rule file is the one failure mode this mechanism can
introduce, and `test/claude-rules.test.ts` fails naming any file that has no non-empty `paths:` list.

**Why pointers only.** CLAUDE.md is the normative index and this file is the single copy of the reasoning. A rule file that restated a rule would be a third
statement of it, free to drift from both — and `backlog-execute`'s contract sweep would then have to visit it. A pointer states no contract, so the sweep needs
no change; the same suite fails any body line that mentions neither this file nor CLAUDE.md.

### How this was measured

The evidence is the **`InstructionsLoaded` hook**, never a session's self-report. It fires when a CLAUDE.md or `.claude/rules/*.md` file is loaded and receives
on stdin a JSON object carrying `session_id`, `load_reason`, `file_path` and — for a glob match — `globs` and `trigger_file_path`. `load_reason` is one of
`session_start`, `nested_traversal`, `path_glob_match`, `include`, `compact`; the probe reads `path_glob_match` off the log.

The harness is a throwaway git repo outside this one (`mktemp -d`) holding a `CLAUDE.md`, `.claude/rules/control.md` with **no** frontmatter,
`.claude/rules/scoped.md` with `paths: ["src/**/*.ts"]`, and `src/target.ts`; a `hook.sh` appending stdin to an absolute `loaded.jsonl`; and a
`probe-settings.json` registering that hook on `InstructionsLoaded` with no matcher. Each case is one
`claude -p … --settings <abs> --allowedTools … --permission-mode acceptEdits --output-format json < /dev/null`, launched in the background and killed by its
recorded pid: the hook log is complete within seconds while the session itself can run for minutes, so waiting on the transcript measures nothing but patience.

`control.md` is the **positive control** and every case keeps one. It is what separates "the rule did not load" from "the hook never ran" — an empty or
control-less log is an inconclusive probe, never a negative result.

### The matrix — Claude Code 2.1.268, measured 2026-09-13

| Case | Question                                               | Verdict                                         |
| ---- | ------------------------------------------------------ | ----------------------------------------------- |
| P1   | headless `claude -p`, plain checkout                   | **positive**                                    |
| P2   | custom subagent does the reading                       | **positive**, under the _parent's_ `session_id` |
| P3   | headless `claude -p`, **linked worktree**              | **positive**                                    |
| P4   | trigger surface beyond `Read` — `Write`, `Grep`/`Glob` | **negative**                                    |
| P5   | source read through `codegraph_explore`                | **negative**                                    |

P1 — `load_reason | file_path`, one `session_id`, `<probe>` for the probe directory:

```
session_start    <probe>/CLAUDE.md
session_start    ~/.claude/CLAUDE.md
session_start    <probe>/.claude/rules/control.md
path_glob_match  <probe>/.claude/rules/scoped.md   (trigger: <probe>/src/target.ts)
```

P2 — the parent held `Read` and `Task` but used only `Task`; the transcript shows the `Read` under `…/subagents/agent-*.jsonl`, and the glob line carries the
parent's id:

```
session_start    <probe>/.claude/rules/control.md
path_glob_match  <probe>/.claude/rules/scoped.md   (trigger: <probe>/src/target.ts)
```

P3 — cwd is `<probe>/.worktrees/probe`, created with `git worktree add`. A glob written relative to the project root still matches when that root is a linked
worktree, and the loaded paths are the worktree's own copies:

```
session_start    <probe>/.worktrees/probe/.claude/rules/control.md
path_glob_match  <probe>/.worktrees/probe/.claude/rules/scoped.md
                 (trigger: <probe>/.worktrees/probe/src/target.ts)
```

P4 — two sessions, each with the control line present and **no** `path_glob_match`. One wrote `src/added.ts` with `Write` and nothing else (the file landed; the
rule did not); one ran `Grep` and `Glob` over `src/`. The trigger surface is a file _read_, not "any tool that names a matching path".

P5 — in this repo, `codegraph_explore` returned the verbatim source of `server/src/orchestrator/orchestrator.service.ts` with the `Read` tool never used, and
the log holds the two `session_start` lines and no `path_glob_match`. This is the one negative with teeth: CLAUDE.md tells sessions to reach for CodeGraph
_before_ `Read`, so a session that follows this repo's own guidance can edit a file whose rule never fired. The pointers are a floor, not a guarantee —
CLAUDE.md remains the surface that every session loads unconditionally, which is why no rule is moved out of it.

### The end-to-end check, in this repo

With the four pointer files in place, cwd this repo's `task-35` worktree, a `claude -p` session told to read one orchestrator file:

```
path_glob_match  <repo>/.claude/rules/orchestrator.md
                 trigger: <repo>/server/src/orchestrator/orchestrator.service.ts
                 globs:   ['skills/backlog-orchestrate', 'server/src/orchestrator', 'shared/agent.ts']
```

Note what the loader reports back: `skills/backlog-orchestrate/**` is normalised to the directory itself, which is why `test/claude-rules.test.ts`'s own glob
matcher treats `dir/**` as "the directory and everything under it".

### What the suite pins, and why it passes on nothing

`test/claude-rules.test.ts` reads `.claude/rules/*.md` as source: every file declares a non-empty `paths:`; every `docs/subsystems/invariants.md#…` anchor
resolves to a real `##`/`###` heading (with the slugifier itself checked against a heading known to round-trip, so a broken slugifier cannot pass by matching
nothing against nothing); every glob matches at least one tracked file _today_, because a pattern that matches nothing is a rule that never fires and fails
silently forever; every body line is a pointer; no file exceeds 25 lines.

It passes **vacuously** on an absent or empty directory, and that is deliberate: P3 could have come back negative, in which case the correct deliverable was
zero rule files and a recorded negative. A guard that went red in that world would have made the honest outcome look like a failure.

## Settings is two pages, the page is the scope

`settingsScope` (`client/src/lib/settings.ts`) is `local | shared`, per device, defaulting to `local`. **Local is everything in this browser's `localStorage`;
Shared is what the API reads off the host** — the watchdog's settings file beside the registry, and the environment the server was started with. No card mixes
the two, and the rail's sub-nav tree is the only thing that switches them, at every width.

### The rule is "the page is the scope", and one card had to split to satisfy it

Settings has carried a scope subtitle per card since task-39 — `this device`, `this machine`, `this server` — because the scope answers a different question
from the name: whether changing a setting affects anybody but the person changing it. Two pages are that same answer moved up a level, and the move is worth
something only if it is true without exceptions. One card was not.

`Claude Agents` mixed backends. Its status lines and its `Setting it up` block report the HOST's environment — `BM_AGENTS`, `CLAUDE_BIN`, the dashboard's
remote-answer pill — while `Default model`, `Default effort` and `Dashboard link` were this browser's `localStorage` all along, sitting under a heading that
said `this machine`. That was tolerable on one page, where the subtitle was the only claim being made. It is not tolerable when the PAGE makes the claim too: a
card that mixes backends makes the band's scope pill a lie about half its own contents.

So the card divides. `Dispatch · this device` is the Local card holding the three per-device rows; `Claude Agents · this machine` stays on Shared carrying the
status row and the conditional setup block, and its status row has **no control in its right slot at all** — which is why `SettingsRow`'s `children` is
optional, and why the empty `.set-control` is not rendered rather than rendered hollow.

`open dashboard ↗` moved with the value that supplies its href, onto the `Dashboard link` row itself. A link driven by a per-device field has no business on the
page that promises everything on it is the host's; and beside the field that sets it, the link stops needing an explanation.

### What was given up, deliberately

`Orchestrator · this device` and `Orchestrator watchdog · this server` used to sit one above the other in the same column, and the adjacency carried meaning:
the same subject read at two scopes — what a run is STARTED with, then what happens to one that has already crashed — met in that order. The split puts them on
different pages, and that is the cost paid for a page that is honestly one backend throughout.

It is recorded here because a test used to protect it. `test/settings-view.test.tsx`'s `renders above the watchdog group` asserted the DOM order of those two
cards, and after the split neither page can be asked the question. It was restated rather than deleted outright — the half that survives is that `Orchestrator`
is on Local and still holds its own two rows — because the adjacency is gone by design, and a test asserting a layout the design deliberately dropped is worse
than no test at all.

### There is no in-page switch, at any width

The dashboard this pattern was ported from draws a pill switch in its Settings band below 700 px. This board does not, and the difference is not an oversight:
the rail's trees stand open at that width, so the tree is reachable in one tap on the phone exactly as it is on the desktop. Runs' two pages already establish
the rule — task-38 deleted `runs-mode.ts`'s `MODE_BUTTON` pair along with the in-page control it named — and a second control here would be a second wording
free to disagree with the tree's. `test/settings-view.test.tsx` pins the absence, because "add a switch on the phone" is exactly the improvement a later reader
would make without knowing it was already decided against.

### The scope pill is the existing primitive, at `neutral`, on both pages

`Band`'s right slot holds one `Pill` — `this browser` on Local, `this machine` on Shared — and the WORD carries the distinction, not a tone. `PillTone`'s five
members each name a *reading* (`live`, `warn`, `bad`, `done`, `neutral`); none of them means "shared", and minting a sixth look inside the settings block would
be a second home for a primitive, which `test/design-guards.test.ts`'s guard 7 exists to refuse.

### The rail reads a SETTING, which moved `SECTIONS` out of the rail

`settingsScope` lives in the settings object rather than in a module-level store like `useRunsMode`, because both of its readers — the rail's tree and
`SettingsView` — already sit inside `SettingsProvider`. Runs' mode needs the store for a reason this one does not have: `RunsView` writes it too, from a surface
with no settings context in its way.

That choice had one mechanical consequence worth stating, because it will be rediscovered otherwise. The rail importing `useSettings` closed an import cycle:
`lib/settings.ts` read `SECTIONS` off `SideRail.tsx` to clamp the `Opens on` preference, and ES imports hoist, so `settings.ts` ran before the rail's body and
saw `SECTIONS` as `undefined` — every suite that loaded the rail died at import. The fix cut the cycle at its real edge: `SECTIONS` and `Section` are
`client/src/lib/sections.ts` now, which is where a list of four strings belonged anyway. The rail keeps the LABELS, as a `Record<Section, string>`, so a section
added to the list cannot ship without one — the same guarantee the old derivation gave from the other direction — and re-exports both names so component-layer
callers are unchanged.

### One tree component, two call sites

`RailTree` (`SideRail.tsx`) is the one render path both trees take. Copied for a second section, the markup's three load-bearing details would become two things
free to disagree: the `rail-sub`/`rail-sublink` class pair, `aria-current="true"` rather than `"page"` (the section row above holds `page`, and two elements
claiming to be the current page leave a reader with two answers to one question), and closing the phone menu on a pick. What legitimately differs per section is
the item list, which of them is current, and what a pick writes — so that is what the call sites supply, and nothing else.

`current` is kept apart from the tree's own `section` for the phone: below 700 px every tree is drawn at once, and a tree whose section is not current must mark
nothing, or the rail announces a current item on a page nobody is looking at.

## `contentWidth` is stamped before first paint, and the CSP hash travels with it

`contentWidth` (`client/src/lib/settings.ts`) is `fixed | full`, per device, defaulting to `fixed`. It is stamped on `<html>` as `data-width` **twice** — by
`client/index.html`'s inline script and by `useSettings`'s effect — and one CSS block keys off it, releasing `.wrap` **and** `.wrap.wide`.

### Why twice

A stamp applied only at mount is the flash bug the theme and density stamps already exist to prevent, arriving under a new name: a `full` install would paint at
the fixed measure and snap out of it on every single load. So the pre-paint script writes it, exactly as it writes the theme, the density and the font scale,
and fails silently back to the default the same way.

The effect's dependency list is the other half, and it is load-bearing rather than tidy. A stamp whose value is missing from the deps still works on RELOAD —
the pre-paint script wrote it — and silently does nothing when the control is clicked. That is the one shape of this bug that survives being developed against,
because reloading is what you do next anyway. `test/settings-view.test.tsx` asserts `document.documentElement.dataset.width` after a click for exactly that
reason.

### Why both wraps

Every section renders in `.wrap.wide` since the Settings split took the shell's narrow-Settings ternary away, so a rule that freed `.wrap` alone would leave the
whole app capped at 1280 px in the one mode whose entire promise is that it is not. The cap is all that goes: `margin` stays `0`, so a released section grows to
the right from the rail rather than re-centring on the window, which would read as the page jumping sideways when the setting is toggled.

### The CSP hash is not optional

`server/src/security.ts`'s `THEME_SCRIPT_SHA256` pins the sha256 of that inline script's exact bytes. Editing the script without recomputing the hash ships a
served build whose theme script the browser refuses to run: the page paints in the default palette at 100% on every load, and **nothing in dev shows it**,
because dev has no CSP (see `security.ts`'s own comment for why the policy is a response header rather than a `<meta>` tag). `test/csp.test.ts` recomputes the
hash from `client/index.html` and is the proof the step was taken.

### Why a source guard, and not behaviour

`test/content-width-style.test.ts` reads files rather than rendering, because both halves of this feature are invisible to a component suite. jsdom applies no
stylesheet, so a rendered assertion on the released measure would pass whether or not the CSS rule existed — and the failure mode is a segmented control that
toggles cleanly and changes nothing on screen. `client/index.html` is never loaded by any suite at all, so React's own stamp would keep every case green while
the pre-paint half was missing. Neither is a detail a reader would think to check by hand, which is exactly why they are checked mechanically.


## The GitHub token never leaves the server, and the poller is armed only while something is connected

Phase 2 of the tracker-backed design (task-45, [spec](../superpowers/specs/2026-09-17-tracker-backed-backlog-design.md) §5) gave this server a credential and a
second outbound-calling module. Both facts change what the rest of the app may assume, and neither is covered by a rule that already existed.

**The token is process-only.** `BM_GITHUB_TOKEN` is read by `githubToken()` (`server/src/tracker/token.util.ts`) and nowhere else, per call and never cached —
the same posture `isAllowedHost` takes with `BM_ALLOWED_HOSTS`, and for the same reason: a value read once at boot cannot be changed by a test or fixed by an
operator without a restart, and the poller's own "armed only while a token is present" rule is a question asked on every tick rather than once. No route returns
it, no payload carries it, and the browser never talks to `api.github.com` at all — every call is board → this API → GitHub.

That is deliberately the same SHAPE as "the browser never talks to the dashboard", stated separately rather than assumed to be covered by it. The dashboard rule
is about an ORIGIN the browser must not reach; this one is about a SECRET that must not reach the browser. Neither implies the other, and this app now has both.
`GET /api/trackers` is what the Trackers card reads, and it carries `hasToken` and a `login` — whether a credential is loaded, and whose — because those are
what an operator needs in order to know the right one is in place. `test/tracker-items.test.ts` asserts the value appears in no response of any route this
module serves.

**`docker-compose.yml` passes it through as an interpolation with a default, never a literal** — bug-25's rule, applied to a variable where the stake is higher.
A literal `BM_AGENTS: 'on'` was a wrong default; a literal token would be a credential committed to a repository, and the fix for that is revoking it rather
than editing the line. Pinned by `test/compose-env.test.ts`, which also asserts the key compose uses is the constant the server reads
(`GITHUB_TOKEN_ENV`), so a rename that missed one half fails here rather than on a machine with a token set.

**Outbound calls go to one constant host.** `API` in `server/src/tracker/github.client.ts` is the only host any request in this app can reach, nothing in a
request shape names a host, and `repo` is validated (`isRepo`, `owner/name` over GitHub's own character set) before it is interpolated into a path. A repo
string arrives from a marker file someone committed, which is not a trusted input just because it is not a request body.

**Armed, idle, off — the watchdog's shape, for the watchdog's reasons.** `TrackerPollerService` is a `setTimeout` chain, never a `setInterval`: the next tick is
scheduled after the current tick's awaits complete, so two ticks can never overlap by construction, and a tick waiting on a slow `api.github.com` can never be
re-entered by its own successor with two syncs racing for one repo's cache. It arms only while at least one registered project resolves to `github` AND a token
is present, and disarms on the tick that finds either half missing. A standing interval against a registry where nobody has connected anything is exactly the
cost the watchdog's own rule exists to refuse — and this loop would make HTTP requests rather than directory reads. `arm()` is called from the bootstrap hook
and from `GithubSource.list`, which is reached precisely when a project resolved to `github`: the cheapest honest signal that something is connected, and the
reason a repo connected after boot is polled from the first board read that touches it.

## The tracker cache is the one cache in this server whose age is a rendered value

`TrackerPollerService` holds every connected repo's issues in memory, per repo, lost on restart and rebuilt by the first sync (task-45, spec §5.1). Every other
read in this server is per request and uncached — the registry, each project's source marker, the run files, `uncommitted` — and those rules are untouched: this
poller re-reads all of them on every tick. What it keeps is the one thing behind a network call with an hourly budget.

The cache is allowed to exist because a per-request fetch is impossible: one board render would be one GitHub request per project, and a person watching the
board would exhaust 5,000 requests an hour in minutes. It is kept honest by being VISIBLE — `polledAt` travels in `ProjectSummary`, the board's band prints its
age (`futin/x · polled 12 s ago`), the item modal prints it beside the body it drew from that same cache, and the Trackers card prints it per project. A cache
whose staleness is on screen is a different object from one that is not.

**A `304` leaves the cache unchanged and MOVES `polledAt`.** Every tick sends `If-None-Match`, and an unchanged repo answers `304` at no cost against the
budget. Task-45 shipped the opposite reading — its authoritative test case said the age did not move, against spec §12.2, and the disagreement was recorded for
the next phase to settle rather than rediscover. Task-46 settled it in the spec's favour, on 2026-09-18, and this paragraph is the record of why.

The argument that won: a `304` IS a successful check. It proves the repo is reachable, the token works, and nothing has changed since — which is exactly what
the rendered age is read for. Under the old reading a healthy connection to a repo nobody is editing looked progressively more broken, its age climbing past an
hour while the poller was in fact confirming the state every fifteen seconds. That is the opposite of what a visible age exists to tell an operator, and it is
the failure mode that outweighs the other reading's one merit — that "how old are these items" is also a true thing somebody might want. It is still available
(an item's own `updated` is on every row) and it is not what the band's line claims.

**Issues and comments each have their own high-water mark, and each read paginates to the end.** They are two streams with independent clocks, and treating
them as one was a defect task-46's own review caught before it merged: `syncRepo` reads issues first, `absorbIssues` advances the mark to the newest issue's
`updated_at`, and the comments request then sent THAT as its `since` — asking for "every comment at or after the most recently touched issue's timestamp". A
claim on an issue that anything else has outlived was therefore invisible to a fresh process, permanently, because no later response ever mentions an unedited
comment again. Nothing read the cache before task-46, so the gap had been harmless and silent; the moment the board's `started`/`phase` and `backlog.mjs stop`
started reading it, it meant a held item drawn as free and a claim the CLI could not give back. Pagination is the same rule one step on: the issues loop always
followed `Link` and the comments read did not, so a claim past the first page was lost the same way.

That is also why `readClaim` does not trust a cache MISS. A miss means "this process has not seen it", never "nobody holds it" — a server that started after
the claim, or a second machine's server, has every right to one — so it falls back to a single fresh per-issue read. The cache stays the fast path and the
common one; the fallback is what makes the answer safe to act on.

**The comments request is made on every tick, and since task-46 it has a reader.** One conditional request covers every comment in the repo, including edits,
which is what makes per-item claim watching cheap. Phase 2 made the call with nothing reading it, deliberately, so that the polling loop's shape, its budget and
its tests would not move in the phase that also introduced the protocol they feed — and that bet paid: task-46 added `TrackerPollerService.comments()` over the
same cache and changed nothing about the loop. `test/tracker-poll.test.ts` asserted the call explicitly while it had no reader, precisely because a call with no
reader is what a later edit deletes as dead. Task-48 gave `comments()` its second reader, `RemoteRunsService`, which derives other machines' runs from the same
cached comments on every `GET /api/orchestrator/runs` and keeps no cache of its own — this stays the one cache.

**Rate limits are a state, not an exception.** Nothing in `github.client.ts` throws on an HTTP status: every response — including a transport failure, which
surfaces as `status: 0` — comes back as a value the poller turns into `access` and `detail`, because every one of them is something the board renders rather
than something a request handler should make a 500 out of. A `403`/`429` with `remaining: 0` or a `Retry-After` puts that repo to sleep until the reset and
records the reset TIME (not a duration, which goes stale the moment it is drawn); a secondary limit backs off sixty seconds. While asleep the repo gets no
request at all, not even a conditional one: a `304` is free against the budget but a `403` is not, and asking again before the reset is how an app earns a
secondary limit on top of the one it has.

**The label set has one home and one cross-file guard.** `server/src/tracker/labels.ts` lists the eight labels spec §5.2 names, and the poller creates whichever
are missing on the first successful sync of a repo — idempotently, case-insensitively (GitHub label names preserve case but collide without it), treating a 422
as success because another machine's poller winning the race still leaves the label there. This is phase 2's ONE write to GitHub, and it is a bootstrap rather
than a lifecycle write: the issue→item mapping cannot work without the set. `skills/backlog/tools/backlog.mjs`'s `connect` writes issue forms that pre-apply the
four `type:*` labels and CANNOT import that module — a skill's `tools/` is a standalone copy of what was pushed — so the agreement is enforced the other way
round: `test/tracker-labels.test.ts` reads the skill's source as text and asserts the two lists match. A comment asking two files to stay in step is what drifts.

## A tracker project has no item files, and that shows up in three places

An issue is not a file, and three separate surfaces would each have got that wrong on their own (task-45, spec §5.3/§5.5). It was FOUR until task-46: dispatch
was the fourth, and the section below records what happened to it, because "this used to be a consequence of having no files and is not one any more" is
exactly the kind of fact a reader needs stated rather than silently removed.

**Dispatch is derived like any other item's, and its per-item block is the live claim (task-46).** Task-45 opened `deriveAction` with
`if (item.source !== 'files') return null`, ahead of every other branch, because a dispatched session would have run the file-writing skills against a project
with no files — all three actions were wrong there rather than merely premature. Phase 3 made that false in three separate ways at once, which is why the line
came out rather than being loosened: the skills detect a tracker project from its own committed marker and write through the API (`backlog.mjs` in API mode),
the claim protocol gives a tracker item a `started` for `progressBlock` to read, and `ItemsService.find` resolves a URN to the same `BacklogItem` a filesystem
path resolves to, so `plan` and `dispatch` re-derive the action from exactly the object the board drew its button from.

The ORCHESTRATOR followed one phase later, and the two-phase shape is worth keeping on the record. Task-46 could not lift it with dispatch, so it gave the
refusal a gate of its own on each side: `projectIsFiles` (`client/src/lib/tracker.ts`) hid the toolbar control, and `AgentsService.orchestrate` answered 400
`orchestrating a tracker project arrives in phase 4` before `resolveIds` — necessary then because `resolveIds` scanned FILES and would otherwise have found
none of a tracker project's ids and 409ed each one as "not an open bug or task in this project", which is both wrong and unactionable.

**Task-47 (phase 4a) removed both, and what replaced them is `resolveIds` learning the vocabulary rather than a looser gate.** `projectIsFiles` is deleted (it
had exactly one job and its own doc comment said so), the 400 is gone, and `AgentsService.resolveTrackerIds` now proves a tracker project's ids against
`ItemsService` where the files path proves them against a directory scan. It accepts all three spellings a caller can hold — `#31`, this project's own URN, and
the bare `31` — and **emits exactly one: bare digits, before the prompt is composed.** See "the orchestrate spawn prompt is composed server-side" and
"`isItemId` accepts three shapes" for why that normalisation is the load-bearing half: the prompt is the one composition that concatenates caller text,
`orchestrate.mjs` reads its argv as tokens, and SKILL.md substitutes those tokens into fenced shell commands where `#` opens a comment.

**`GET /api/items/uncommitted` answers `known: false`.** "Which item files differ from `main`" is not a question with a wrong answer for a tracker project; it is
a question with no meaning, and `known: false` is the shape this endpoint already has for that. The Orchestrate sheet's existing `known` gate keeps the chip
off, so nothing on the client changed. What did not change either: `uncommitted` stays a sibling endpoint rather than a `BacklogItem` field, and nothing derived
reads it.

**The body route dispatches on the ref's SHAPE, in one place — and since task-46 so does the item lookup.** `ItemsService.body` sends a
`gh:<owner>/<repo>#<n>` URN to the GitHub adapter and anything else to files — the seam's one home for that decision, exactly where phase 1's comment said it
would arrive — and `ItemsService.find` makes the identical dispatch for the agents routes. `AgentsService.findItem`, which used to hold a private copy of the
files adapter's allowlist-and-scan, is now a one-line delegate to it; that private copy was precisely why a tracker item had no dispatch, and removing it is
half of the lift. The shape test is the ref's and never the caller's:
nothing in the request says which source to ask, so a caller cannot route its own filesystem path to an adapter by asserting a kind, which is the same rule
"dispatch derives the action, it never accepts one" states for the agents routes. The adapter then gates on the REGISTRY, exactly as the files allowlist does: a
URN naming a repo no registered project is connected to answers `null` and the route 404s, rather than a repo merely sitting in the cache being readable.

**`untyped` is a rendered badge and nothing derived reads it.** An issue with no `type:*` label lands in `ideas` with `untyped: true` and no error — a blank
issue filed through the web UI is an ordinary state. Two type labels IS an error: the issue claims to be two things, so the item is produced from the first
label alphabetically AND an entry naming the issue joins `ItemsIndex.errors`, the same tolerant contract a malformed item file gets. `deriveGroomed`, `isStale`,
`lastTouched` and the orchestrator gate never see `untyped`: an untyped issue is an idea to every predicate until somebody labels it, which is the whole reason
`ideas` is the fallback rather than a sixth section.

A closed issue's section can change while its labels never do: `completed` (or no reason at all, which GitHub sent before 2022) is `done` with its section
intact, and any other reason is `terminal` in `out-of-scope`. The `type:*` label stays on the issue, so the original type is recoverable — which the file store
cannot do, since a rejected item moves into a flat directory that forgets it.

## The seven item-write routes are guarded, refused for `files`, and serialised per item

Task-46, spec §6.2. Until this branch every route in this server either read something or spawned a session; these seven CREATE AND CLOSE ISSUES in somebody's
repository, with a credential the browser never sees. That is a strictly larger consequence than the dispatch route the origin guard was written for, which is
why every one of them carries `@UseGuards(SameOriginPostGuard)` — one decorator on `ItemsWriteController`, so "is this route guarded" cannot become a
per-method question. `test/agents-origin-guard.test.ts`'s list is where the guarded set lives, now keyed by full path because it spans two controllers.

A JSON POST with NO `Origin` still passes, by the guard's existing rule, and that is not a hole this branch widened: `backlog.mjs` in API mode is exactly that
caller. It is a Node process, not a browser; requiring an origin would break every skill while adding nothing a browser cannot forge anyway. The check that
actually stops a cross-origin form is the content type, which a form cannot send without a preflight there is no CORS to answer.

**One gate, four answers, and none of them makes a network call.** `ItemsService.writerFor(projectPath)` is the whole of it: a raw string compare against the
registry's own `path` (deliberately not realpath — the `uncommitted` rule, and load-bearing for the same reason: realpath-ing an unregistered path would itself
be a filesystem touch on a path this server was never given), then `resolveSource` per request, then the adapter's `writer`. It answers `unregistered` → 404,
`files` → 400 `this project's items are files — the skills write them directly`, `unsupported` → 400 carrying `resolveSource`'s own path-prefixed reason, and
otherwise the writer. `FilesSource` has NO `writer` field at all, and that absence is the rule rather than a gap: item files are written by the skills and by
nothing else, and the one check that reads the field is what makes that true for all seven routes at once instead of seven routes each remembering to ask.

**Every refusal is a value.** `ItemWriter` answers `WriteOutcome`, never throws, and `GithubClient` beneath it answers a `GithubResponse` for every status —
the same posture, one layer down. The controller is the only place a `refused` becomes a status: `no-token` 503, `not-found` 404, `conflict` 409,
`rate-limited` 429 with the reset TIME, anything else 502 carrying GitHub's own status. Each was chosen for what the READER can do about it — fix the
environment, fix the id, re-read and retry, wait, or nothing local at all.

**Serialised per item, absorbed into the cache, and `polledAt` untouched.** `GithubSource` keeps a `Map<urn, Promise>` and every write to one URN awaits the
previous write to that URN: two local sessions (a groom and an execute in two terminals) would otherwise interleave inside the claim protocol's settle window
and produce two live claims nobody resolves. Across machines the protocol itself is the guard. Each write's response is then upserted into the poller's cache,
so a capture is on the board on the next read rather than up to fifteen seconds later — but `polledAt` does NOT move, because nothing was polled and the other
issues in that cache do not have the freshness a moved stamp would claim for them.

**The token never leaves the process.** It is read per call inside the adapter, and no response shape here carries it; a project with no token gets a 503
naming the ENVIRONMENT VARIABLE, which is the thing an operator can act on.

**`heartbeat` accepts one field on a RELEASED claim (task-48).** A request carrying `finished: { at, status }` is taken on a released claim too, and there it
sets `finished` and nothing else — no heartbeat, no state, never an un-release. `orchestrate.mjs finish` stamps the run's outcome on its last-touched claim, and
that claim's terminal stage has normally released it already. `finished` is validated field by field like `run` (a derived run's status IS that value), where
`state` is still taken outright. It rides the heartbeat route rather than an eighth write route so the count below stays seven.

**There is an eighth route, and it is a read.** `GET /api/items/claim` answers who holds one item, out of the cache, with no network call — unguarded, like
every other GET in this app, because it starts nothing and discloses strictly less than `/api/items` already does. It exists because `backlog.mjs start` and
`backlog.mjs stop` are two PROCESSES: `claim` answers the comment id that identifies the claim, and the `stop` that must release it has no other way to
rediscover it. Without it the CLI could take an item and never give it back. Spec §6.2 names seven routes and not this one; the deviation is recorded in
task-46's Outcome.

## The claim protocol: lowest live comment id wins

Task-46, spec §6.3. A claim has to be readable by every machine, editable in place, ordered consistently, and visible to a PERSON looking at the issue in
GitHub's web UI. A label is not ordered; an assignee cannot carry counters; a hidden field does not exist. A comment is all four — which is why `renderClaim`
writes a human sentence under the fenced JSON: somebody reading the timeline should see who holds the issue without knowing this protocol exists.

**Why the LOWEST live comment id, and not the highest.** GitHub assigns comment ids monotonically, so lowest means "posted first", and every reader of the same
comment list reaches the same verdict with no lock, no lease server and no clock they have to agree on. Highest — last writer wins — is not convergent at all:
a third claimant arriving mid-race would change the answer for everyone who had already decided.

**The sequence is list · post · settle · list · UNION, and the union is what decides.** GitHub's comment listing is eventually consistent by a fraction of a
second, so a concurrent claimant can be absent from one list and present in the other; taking the second list alone would let both racers believe they won.
`settleMs` is one second in production and is set to `0` by the suites, whose cases are about which comments are in the union rather than about waiting.

The plan for task-46 wrote the first listing as happening AFTER the post. It is done before, and the difference is the counters: a seed read from a list made
after our own post would have to come from the cache (up to a poll interval stale) or force a second edit of the comment just written. Listing first costs
nothing — two listings either way — and the union still spans both, so the race semantics are untouched.

**A loser DELETES its own comment; a stale claim is RELEASED, never deleted.** That distinction is the whole reason a claim is a comment rather than a flag. A
losing claim is litter this call chain created seconds ago and nobody has read. A stale claim is the permanent record of work somebody did, carrying the
counters to prove it — deleting one to tidy up a flag would erase the only evidence that the work happened. The retiring session writes
`released: { reason: 'stale', by: <itself> }`, so the record even says who retired it.

**Who may release: the holder always, ANYONE once the claim is dead.** The asymmetry is the same rule seen from the other side. A dead claim is not somebody's
property, and requiring the original session to come back and clear it would wedge an issue on the crash of a process that is never returning.

**The counters live in the claim, the server seeds and the CLI bills.** Spec §6.4 is explicit that counters never live in the body: the body is the item's text,
groom rewrites it wholesale, and a number embedded in prose somebody edits in the web UI is a number that silently resets. A claim comment is machine-owned,
which is the property frontmatter has for a files item. The server seeds a new claim from the newest prior one so that ONE comment is a whole history; the CLI
computes the totals on release, because it holds the clock the session started on and the transcript the tokens are read from — exactly where `stopItem`
already is. `--abandon` sends no `counters` key at all, and that is not the same as sending zeros: zeros would overwrite the seeded totals and erase every
earlier session's work on the item.

**`CLAIM_STALE_MS` is a named alias of `RUN_STALE_MS`, not a second fifteen minutes.** The two answer different questions — is the orchestrator run alive, is
the session holding this issue alive — and today's answer is the same number. The alias exists so phase 4 can give a hand-driven skill claim a longer window
without touching run semantics. It is a known tension rather than a solved problem: nothing heartbeats a hand groom automatically, so the skills' prose asks
for `heartbeat` between long steps and the protocol retires whatever stops answering.

**The mapper reads liveness NOWHERE.** `mapIssue` fills `started`/`phase` from an UNRELEASED claim without consulting its heartbeat, because the board's rule
for a files item is "ANY stamp, fresh or stale" (`progressBlock`), and what retires a stale claim is the PROTOCOL, at the moment another session contests the
issue. A mapper that expired claims on its own would show an item as free while the next `claim` call still had to fight for it. The counters come off the
newest claim whether or not it is released, because they are the item's running totals rather than a fact about who holds it.

## `isItemId` accepts three shapes

Task-46. The predicate now admits `[a-z]+-\d+` (a files id), `#\d+` and `gh:<owner>/<repo>#\d+`, and the cap moved from 64 to 200 characters because GitHub
allows a 39-character owner and a 100-character name, so a real issue's real URN can run to ~154 and a 64-cap would have answered `false` for it. The two
nonsense cases the cap exists for — a 500-character blob, a `task-` followed by 500 digits — are refused exactly as before.

`#` is the one shell metacharacter these shapes add, and it is worth saying plainly why that is safe HERE rather than trusting that it happens to be: nothing
this predicate guards reaches a shell. The dispatch prompt is prose handed to a spawned session over JSON, and the orchestrate prompt — the ONE composition in
this build that concatenates caller-supplied text — **never carries a `#`, because every accepted id is normalised to bare digits before it is composed**
(`AgentsService.resolveTrackerIds`, task-47).

**That normalisation replaced a refusal, and the swap is the thing to understand here.** Task-46's guarantee was that a tracker project could not be
orchestrated at all, so no `#`-bearing id could reach the prompt; task-47 (phase 4a) lifted the refusal and put the normalisation in its place. The
normalisation is the stronger of the two — nothing is refused for carrying a `#`, it simply never survives to the prompt — but it is also the more fragile,
because it is one `replace` rather than a closed door. `orchestrate.mjs` reads its argv as tokens and SKILL.md substitutes those tokens into fenced shell
commands, so anything that weakens or routes around the normalisation needs proving safe against THAT reader, not against this predicate.

## The driver owns a tracker item's claim for the whole item

Task-47, spec §7.1. On a tracker project the orchestrator's driver claims an item's issue at `stage <n> preflight` — **before the worktree exists** — and
releases it at the item's terminal stage. The dispatched `backlog-execute` session never runs `start`, `stop`, `heartbeat`, `move` or `comment` on the item at
all, which is the exact opposite of the files arrangement, where execute stamps the item file itself.

**The reason is the worktree.** A files item's marker is a line in a file the execute session has in its own tree. A tracker item's marker is a comment on an
issue, and the session that would post it lives in a directory with no `run.json`, no run id, and no way to say which run it belongs to — so a claim it posted
would be indistinguishable from a hand `backlog.mjs start`, and the resumed-driver takeover below could never recognise it. The driver has all three facts.

### What rides on the claim, and what reads it

`ClaimRecord.run` is a `ClaimRun`: `runId`, `startedAt`, `mergeMode` (the EFFECTIVE one — a reader wants to know whether this item will be merged, not what was
hoped for before a classifier said no), `questionMode`, `maxItems`, `base`. It is on EVERY claim of the run, redundantly, because a run's items are claims on
different issues and this object is the only thing that groups them: §7.3's cross-machine assembly starts from whichever claim it happens to have.

`ClaimRecord.state` is a `ClaimState` — the `RunQueueItem` fields §7.1 names, written through `heartbeat` by every command that changes one (`stage`, `usage`,
`verify`, `assume`, and `watch`'s tick). It is declared in `shared/types.ts` and typed nowhere else: the fields are restated rather than `Pick`ed off
`RunQueueItem`, because this shape crosses a boundary with mixed-version readers by construction and what crosses it has to be a decision rather than a
consequence of whatever the queue item grew this week. Its one reader is task-48's remote-run assembly, `readClaimState`, which keeps each field only when it
has the right shape and drops the rest — a claim from a newer build, or a hand-edited one, makes a drawn remote run say less rather than making the read throw.

`run` is TYPED where `state` stays `unknown`, and the asymmetry is the rule rather than an inconsistency: the server BRANCHES on `run.runId`, and a field a
decision depends on cannot stay an opaque blob. `state` is round-tripped verbatim and no predicate in this build touches it.

### The three failure postures, which are deliberately not the same

- **A failed heartbeat is one stderr line and never fails the command.** `run.json` is the journal of record on this machine; the claim's `state` is a
  published copy. Failing a `stage` call over a copy would cost this machine an item mid-flight for a write nothing local depends on.
- **A failed release is one stderr line too.** By then the item has reached its terminal stage and, on the `merged` path, the issue is already closed; refusing
  would report a finished item as unfinished. A dangling live claim goes stale within `CLAIM_STALE_MS`, which is the protocol's own repair.
- **A failed CLOSE is exit `9`, with the stage NOT written and no release sent.** That one is not a copy — it is the only record anywhere that the item is done
  — and an item staged `merged` whose issue is still open is an issue nobody ever closes, because the run has moved on and no later command looks back.

**The known trade:** an API down for fifteen minutes lets a claim go stale, and the next contestant retires it. That is the protocol working as designed, and
the alternative (failing every command that cannot publish) trades a rare lost item for a common stalled run.

### Same-run takeover, and the three things it is not

A resumed driver re-claims each in-flight item at `claim`, and the claim it is contesting is ITS OWN RUN'S — posted by the session that crashed, still live
because it was heartbeating minutes ago, still holding the lowest comment id. Under the plain protocol the resume loses every item to a process that no longer
exists, once per item, for fifteen minutes each.

So `GithubSource.claim` drops from the live set every live claim whose `record.run?.runId` equals the request's, and the lowest-id rule then decides among the
rest — which is the question that actually matters: has another RUN taken this item? A dropped claim is then `released: { reason: 'resumed' }`, never deleted,
and its counters are carried forward by the ordinary seed. Three things this is not:

- it never drops the caller's own comment, which carries the same `runId` and would otherwise take itself out of the race;
- it never matches a claim with **no `run`** — a hand `backlog.mjs start` is somebody working the item at a terminal, and a run has no standing to evict them;
- it never deletes. The only thing this protocol ever deletes is a loser's own comment, seconds after posting it.

### Ids, and the outcome file

**Inside a run a tracker item is its bare issue number** (`31`), where the board and a person both say `#31`. `#` opens a comment in every shell SKILL.md's
fenced blocks use, and the id is substituted into dozens of them. `queueItemIs` (`shared/agent.ts`) is the one place the two spellings are reconciled, gated on
`item.source === 'github'` rather than on how the id is spelled — the question is which STORE the queue entry belongs to.

**The session's `## Outcome` goes to `<dir>/outcomes/<n>.md`**, an absolute path the dispatch marker names, created empty by the driver. Under the run-state
directory and never in the worktree, because §6 stages the worktree with `add -A` and an Outcome written there would be committed into the project's history.
`orchestrate.mjs snapshot <n>` then writes `<dir>/items/<n>.md` — the issue body, `## Outcome`, that file — which is what the reviewer is handed where a files
run hands the item file, and what `verify` reads `## Done when` out of. Both directories ride the existing archive mover with no change to it: it is a denylist
of two (`run.json`, `runs/`), which is exactly the property that makes a new sidecar directory free.

### What the rest of the run publishes (task-48)

Three more commands publish to the issue, each after the run file is written and each best-effort with the heartbeat's posture — one stderr line, exit `0`:

- **`finish` stamps `finished: { at, status }` on the run's LAST-TOUCHED claimed item** (the one whose newest `stageAt` is latest), through the `heartbeat`
  route. That route accepts `finished` on a RELEASED claim — the one exception to "a released claim refuses a heartbeat" — and there it sets `finished` and
  moves nothing else, because by then the item's terminal stage has normally released the claim and release is permanent. It is how another machine tells a
  finished run from a crashed one. `at` is the run file's own `updatedAt`, so the stamp and the journal name one instant.
- **`attention` posts a comment** — `<!-- bm:attention kind=<kind> run=<runId> -->` on line 1, then `@<login> <detail>` — so a phone notification replaces the
  strip badge. The login comes from `GET /api/trackers`; without one the mention is omitted, never guessed. The marker's CLI literal and the server's
  `ATTENTION_LINE` cannot import each other and agree through a source-reading guard (`test/remote-runs.test.ts`, G-1). **Known risk:** GitHub may not notify
  a user of their own `@mention`, and the token is the user's own; the fix for that is a GitHub App identity (spec §15), not a workaround here.
- **`heartbeat` heartbeats every claim the run still holds** — `claim` set and the stage not in `CLAIM_RELEASE_STAGES`, so `needs-answers` is included. Before
  this it stamped only `run.json`, and a review longer than fifteen minutes let the in-flight claim go stale and read as crashed on another machine.

And one command READS the issue: **`reconcile` adds a `claim` column** in a tracker project — `this-run` / `other` / `released` / `none` / `unknown` — and
`other` (another run's LIVE claim) turns the suggestion into `skip`. A files run's report has no `claim` key at all.

## Remote runs ride beside `runs`, never in it

Task-48, spec §7.3. `GET /api/orchestrator/runs` carries a third top-level array, `remote`: runs on a tracker project that ANOTHER machine drove, assembled by
`RemoteRunsService` from the poller's cached claim comments — never from a file, and with no cache or network request of its own. The derivation is pure
(`deriveRemoteRuns`, `server/src/orchestrator/remote-runs.util.ts`): group the repo's claims by `run.runId`, one queue item per issue from its newest claim,
the run facts off any member, `finished` off whichever claim `finish` stamped.

**It is never a member of `runs`, for a stronger reason than `starting`'s.** `runs` means "this machine's run files, one per project", and three things lean on
exactly that: the `RUN_IN_PROGRESS_CODE` lock, which would 409 a local Orchestrate because another machine is draining the same project — spec §7.4 says two
machines must NOT block each other, and the claims already keep them disjoint; `runClaimBlock`; and the watchdog, which must never try to resume a run whose
driver is on another machine. So `OrchestratorService.runs()` fills `remote: []` and `OrchestratorController.runs()` overwrites it — the service's direct
callers in `AgentsService` never see a remote run.

**The same `runId` locally and remotely: the local one wins, whole.** A derived run is dropped when any run file on this machine — a project's `run.json` or an
archived `runs/*.json` (read by NAME, through `archivedRunFiles`) — carries its id. Nothing merges field by field: overlaying claim state onto the local journal
would make "which one is right" a per-field question.

**`project` is this machine's registry path for the repo**, never anything a claim says; a claim carries no path, and another machine's would mean nothing here.

**Status is not the spec's "else the last-touched claim's outcome".** It is the newest `finished` stamp's status when no OTHER claim in the group heartbeated
after it; otherwise `running`, `fresh` by the newest heartbeat. The spec's rule would report a crashed run as finished, and "a crashed run renders as crashed,
never as nothing" holds for a remote run too. The stamped claim's own heartbeat is excluded because `finish` on an unreleased (`needs-answers`) claim moves it to
the server's clock, milliseconds after `finished.at`; a resume never needs it, since a re-claim is a takeover that posts a NEW comment. A released claim whose
`reason` is a stage reads as that stage — the driver releases at a terminal stage without a final state heartbeat, so `state.stage` is the one before.

**A remote run is read-only, and says so.** Pause, resume, abort and the watchdog are all local mechanisms on the machine holding the run file, so the Runs
detail sheet draws `Remote run: its controls are on the machine that ran it.` in the controls' slot and never fetches `archive/run`. A queue holds only what
the run has CLAIMED, and the sheet says that too; a LOCAL run of a tracker project that has claimed nothing says it is not visible from other machines.

## `backlog.mjs` in a tracker project needs the stack up

Task-46, spec §6.5. A project whose committed marker says `github` has no item files, so every command routes through the backlog-manager API on this machine,
which holds the credential and does the writing. A project with no marker never reaches any of that code: `files` mode runs the same synchronous path it always
did, and `test/…/backlog.test.mjs` asserts a files fixture makes zero HTTP requests across `init`/`new`/`show`/`board`/`start`/`stop`/`move`.

**Mode is read from the marker and nothing else**, by `sourceMode` — the CLI's own copy of `resolveSource`, restated rather than imported for the reason the
label list is: a plugin skill's `tools/` is a standalone copy of what was pushed, with no build step and no path back into this repo. It carries the same
load-bearing negative: a marker this tool cannot read is exit `1`, NEVER a fallback to files. Falling back would write item files into a project whose items
live on GitHub, on one machine, where nothing would ever report them missing.

**There is no offline queue, deliberately.** A write parked on one laptop would be a second source of truth for an item's state, invisible to every other
machine — which is the exact failure the tracker-backed direction exists to remove. A refused connection is exit `5`, a new code, naming the port and both ways
to start the stack. A new code rather than reusing `1` because "the store said no" and "there is no store reachable at all" are different things to a caller and
the second has the same fix every time.

**`main` is async, and the entry guard awaits it.** The "all three skill CLIs exit through `process.exitCode`" rule is about `process.exit()` truncating a
pipe, which asynchrony has nothing to do with; what it actually requires is that nothing hold the event loop open when `main` returns. Every `fetch` here is
awaited to completion and each carries `connection: close`, so no pooled socket outlives the call. The source guard accepts `= await main(` for this file alone
and still requires the synchronous form of the other two, which hold no asynchronous work at all.

**Three spellings, one issue.** `31`, `#31` and this project's own URN all name the same item, because three different callers arrive with three different
handles — a person types the number, a skill's prose says `#31`, and the board posts `BacklogItem.path`. A file-shaped id (`task-31`) and a URN naming another
repository are each refused with their own sentence: the first is a habit carried across from a files project, the second is a caller asking this project's
credential to write somewhere else.

<!-- docs-sync:
  sources:
    - server/src
    - client/src
    - shared
    - skills
    - agents
    - scripts
    - test
    - docker-compose.yml
  kind: subsystem
  verified: d3dbf8855e78b4ae70c792eeb7696167a44ce8a4
-->
