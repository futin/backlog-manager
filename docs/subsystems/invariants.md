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

**One writer is not one process** (#255). Two `backlog.mjs` runs in two repos can upsert at the same moment, and the old read-modify-write — a catch that read
any failure as "empty registry", then a truncating `writeFileSync` — let one of them catch the other mid-truncate, fail to parse, and write back a registry
holding only its own project: every other project gone from the board, and its tracker writes refused, until each captured again. Two changes close it. Every
write is a temp file renamed over the registry in its own directory, so a reader only ever sees a whole file. And only `ENOENT` starts fresh: a file that does
not parse, or has no `projects` array, is left byte-identical, copied aside to `registry.json.corrupt-<ts>`, and the registration is skipped with a stderr line
— the capture still succeeds. What remains is a lost update, last rename wins, which drops one upsert the next capture restores rather than every entry.

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

One writer is not one writer PROCESS: `verify` runs detached beside the driver's `watch`, and each used to do a blind read-modify-write of the same file, so a
heartbeat that read before verify's write and wrote after it put the item's old `verification` array back (#349). Both now go through `mutateRun`, which
holds `<dir>/run.json.lock` (created `wx`, stamped with the pid) across the re-read and the write; a lock whose pid is dead or whose stamp is older than 30 s
is broken, and a waiter past `BM_RUN_LOCK_TIMEOUT_MS` (default 5000) exits `1` naming the lock with nothing written. `writeRunAtomic` alone is atomic per
write, never serialised across writes — a third writer that can run concurrently with these goes through `mutateRun` too. The reader never takes the lock.

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

**A denylist of three, not an allowlist of five.** The mover skips `run.json` (renamed by `cmdInit` itself moments later), `runs` (which it would otherwise bury
inside its own newest entry) and `stale-plans.json` (#322 — project-level state that outlives every run, not a run's sidecar: archiving it with the run that
filed it would unmark every item at the very next `init`), and moves everything else. The sidecar directories are created by _drivers following SKILL.md prose_
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

## A stale-plan mark is keyed by the plan's hash, so a re-groom clears it and nothing else does

#322. An execute session that finds its plan contradicted by the code writes an Outcome whose first line is `Plan no longer holds: …`; `inspect` reports that
line as `planStale`, the driver stages the item `ungroomed --plan-stale`, and that stage files a mark in `stale-plans.json` in the project's run-state
directory. The stage takes no `--note`: it re-reads the line from the Outcome `inspect` read, through the same function, because the line is the session's prose
and prose a run did not compose never rides a command line (bug-31) — one apostrophe in it would break the driver's shell call. `orchestrate.mjs` is the file's
only writer and its only reader — the gate in `buildGatedQueue`, shared by `plan` and `init`, on both the files and the tracker path — the same relationship the
tool already has with everything else under that directory; the server's run-state reader never opens it.

The key is the sha256 of the plan's own text (`## Plan` for a task, `## Fix` for a bug), trimmed, CRLF normalised and with the `bm:groomed-at` footer stripped,
read from the bytes the gate reads: at `<base>` in a files project, from the API in a tracker one. A mark whose hash still matches turns a `ready` or
`needs-answers` verdict `ungroomed` with the reason `plan no longer holds (run <runId>, <date>): <detail> — re-groom it`; a mark whose hash does not match is
ignored. That is the whole clearing mechanism, deliberately: a re-groom changes the plan's words and so the hash, while a re-stamp of the anchor, a line-ending
rewrite or a heartbeat changes nothing a person decided. A "clear" verb would be a second way to dispatch the same stale plan, which is the failure this exists
to stop — before it, the next run's gate read the item `ready` and dispatched it again.

The mark is filed after the run file is written, and its hash is computed before either write, so a refused stage leaves neither. `plan` reads the file without
ever creating the run-state directory, and an absent, empty or malformed file reads as no marks: failing open costs at most one session, because execute's own
`drift` re-check is the backstop. `archiveSidecars` names the file in its denylist (above), and nothing in this task removes the worktree or branch an item
staged this way keeps — `cleanup` still refuses every stage but `merged`/`branched`.

## `~/.backlog-manager/retro/` has exactly one writer, and the retro never writes run state

**task-30.** This is the third directory under `~/.backlog-manager/` that a tool owns outright, and it keeps the same relationship the other two do:
`registry.json` has `backlog.mjs`, `run.json` has `orchestrate.mjs`, and `~/.backlog-manager/retro/` has `retro.mjs record`. `$BM_RETRO_HOME` overrides it for
exactly the reason `$BM_ORCH_HOME` exists — so a test process, or somebody poking at the tool by hand, can never write into a real machine's history.

**`sweep` opens the retro home, and it opens it read-only.** That is the one crossing into the directory `record` owns, and it exists because a retro's whole
value is the comparison: "fix loops are 38% of dispatched items" is a number, and "31%, after task-28 landed" is a finding. The deltas need the newest record,
so `sweep` reads it — and reading it is all it does. "Newest" means newest at the sweep's own scope (#270): a `--project` sweep differences against the last
record of that project, a machine-wide one against the last machine-wide record, because two scopes count different populations and their gap is not
movement. The write stays in `record`, behind one command a session calls once at the end.

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
archive directory as "only that run's" — the first archive after task-31 swept 74 transcripts belonging to a dozen runs into one stem — so a session is still
joined to an item by `(project, itemId)`. Among the runs that dispatched that item, the one whose own sidecar root holds the transcript owns it (#345): the live
run writes flat and `init` moves that into `runs/<stem>/`, so that run wrote the surviving bytes, and no `collision` is reported. Only when no candidate's root
holds it — a pre-task-31 archive, or older runs' logs swept into a later run's stem — is it attributed to the latest dispatching run, bounded by the archive's
own run start when the archive is a known run's, and only then does an item two runs dispatched produce the `collision` caveat. Attributing every transcript to
the latest run had filed an older run's cost against a newer one and read the older usage entry as `unjoined`.

Spec: [2026-09-06-backlog-retro-design.md](../superpowers/specs/2026-09-06-backlog-retro-design.md).

## `~/.backlog-manager/tick/` has exactly one writer, and the tick never writes run state

**backlog-tick** (spec: [2026-10-22-backlog-tick-design.md](../superpowers/specs/2026-10-22-backlog-tick-design.md)). The fourth directory under
`~/.backlog-manager/` a tool owns outright, and it keeps the relationship the other three do: `registry.json` has `backlog.mjs`, `run.json` has
`orchestrate.mjs`, `retro/` has `retro.mjs record`, and `tick/<project-key>/` has `tick.mjs` — in fact `tick-state.mjs`, the one file in the skill that writes.
Three files live there per project, `lock`, `state.json` and `last-decide.json` — the last (#367) a display record of the caps `decide` saw, written without
the lock and never read back by the tool, so it can never steer a verdict; the key is `encodeURIComponent` of the absolute main-checkout path, the key `orchestrate.mjs`'s
`projectDir` computes, so one project is one name across both tools without either importing the other. `$BM_TICK_HOME` overrides the home, for the reason
`$BM_ORCH_HOME` and `$BM_RETRO_HOME` exist: a test process, or somebody poking at the tool by hand, must never write into a real machine's tick history, and
above all never into a lock a scheduled step is holding.

**Nothing under the run-state directory is ever written, and what is read is read to say `busy`.** A tick runs beside an orchestrator, not inside one, and the
one thing it needs from it is whether the project is occupied: a `run.json` that says `running` or `paused`. So `decide` opens that directory read-only, and
the sidecars, the control file and the run file's every other field are none of its business. A tick that wrote there — a note on a run, a cleared lease —
would be a second writer of the run file, and the whole reason `run.json` has one is that every reader of it has to be able to trust that a field it reads was
written by the one place that knows what it means. The same line keeps the tick off the registry and off every item file: it asks `backlog.mjs` nothing and
runs nothing of it itself — the session that carries the verdict out runs the skills, and those are the item files' only writers.

**It is self-contained on purpose, and a twin is a copy with a named original.** `tick.mjs` imports nothing from another skill's `tools/`, from `server/` or
from `shared/`, and shells out to neither `orchestrate.mjs` nor `backlog.mjs`, because an install is a copy of whatever shipped and a prune of one skill must
never break another. Every function it needs that exists elsewhere — the project key, the gate's readiness and ordering, the live-claim window, the section
prefixes, the Jira-free subset of the frontmatter reader — is a TWIN, with a comment naming each original, the pattern
`skills/backlog-retro/tools/lib/paths.mjs` set. The cost is paid where a copy always costs: a rule changed in one home has to be changed in the other, which is
why each twin names its original and why the tool's own suite pins the behaviours that must agree. Nor does it write git: every git call in the file is a read,
because the tick's units do their own — an execute's `pr` finish owns its branch and its worktree — and a scheduler that also wrote git would be a second hand
on the same refs.

**The server reads this directory and writes none of it.** The tick breaker's board (`server/src/tick/`, `GET /api/ticks`) lists one row per project directory
and derives each row's streak from `state.json`, so "exactly one writer" is a statement about writes, not about readers: `tick.mjs` writes the home, the server
only reads it, and the one file the server does write for the breaker is `settings/tick.json`, outside the home (see the `tick.json` section below).

## A tick does one unit, only when idle, and never executes a plan that awaits review

**backlog-tick.** The skill exists so that a dashboard job can fire as often as it likes — every half hour overnight — and the cost of an unnecessary firing is
one tool call and one line. Three properties make that safe, and each is a refusal rather than a feature.

**At most one unit.** `tick.mjs decide` prints ONE verdict: `execute <id>`, `groom <id>`, `recover`, `busy` or `idle`. Execute wins over groom, because a ready
item is worth more than a plan for another; a groom runs only while fewer than N items carry `plan-review`, and an execute only while fewer than M `execute/*`
pull requests are open. The caps are what stop the morning stack — twenty plans to read, a dozen PRs that conflict with each other — and they are settings,
not code. Each resolves in one order: the trigger flag (`--max-plans`, `--max-prs`), else `tick.json`'s `maxPlans` / `maxPrs` (Settings › Shared › Backlog
tick, an integer 1–10), else 3 and 2 (#378). The flag wins because a number written into one schedule's prompt is a fact about that schedule; the setting exists
because most schedules say nothing, and changing a machine-wide limit by editing every job's prompt was the friction it removed. The setting's floor is 1, not
0 — "never groom" is a schedule that should not exist, not a cap — while the flag still accepts 0 for the one job that wants it. The open-PR count is the one read that can fail
quietly, so every failure is a cap: no `gh`, a non-zero exit, output that does not parse, or a result that reaches the `--limit 500` ceiling (which may have
been cut) reads `cannot count open PRs` and execute is skipped, never assumed zero. The lock is the other half: `decide` writes it only on `execute` or `groom`,
so an `idle` or `busy` tick — and every `--dry-run` — leaves nothing behind that could block the next one, and `record` releases it. It closes the window
between a tick choosing an item and the skill writing its `started:` marker or claim.

**Only when idle.** Anything already happening to this project's pipeline is `busy`, and the tick exits: a `running` or `paused` orchestrator run; a
board-started run that has no run file yet (server memory, so readable only while the stack is up — with it down there is no board to have started one, and the
check is skipped); a `started:` marker on any open item in the main checkout or a linked worktree, since an in-place groom or execute in a linked worktree
writes its marker there; a live claim; and, on a tracker project, a fresh remote run, because between items such a run holds no claim and the claim race alone
would let a tick slip an item in under it. The orchestrator's own `.worktrees/<id>` trees, execute's `.worktrees/execute-<id>` trees and a PR-mode groom's
`.worktrees/groom-<id>` trees are skipped, because the run file speaks for the first and the lock and the candidate exclusions for the others, and a killed
execute or groom there would otherwise block the project for good. A tracker project with the stack down is `idle: stack down`, taken before the lock. A tracker
project whose repo the server's poller has not read yet, cannot read, or read into no rows for it is
`idle` too, before the busy check (#332): every one of those leaves `/api/items` with nothing for the project, and an empty index is not an idle project. A Jira live session is NOT a busy signal: Jira work happens in its own worktree on a ticket.

**Never a plan nobody has read.** The tick writes plans unattended, and the user's review is the only check on them. Because `/git-sync` commits any uncommitted
work, "the groom is uncommitted" cannot be that check — it would approve every plan overnight — so the gate is an explicit mark, `plan-review`: a label on a
tracker project, a `plan-review: true` frontmatter line on a files project, written by groom in the SAME write that lands the plan (`backlog.mjs body|new
--plan-review`, or the frontmatter block groom prints), never as a second step, so no approved-looking plan is ever reported written without it — on a
tracker the `body` route adds the label itself BEFORE the patch and refuses with nothing written when the add fails, so the patch's own response carries
the mark the tick's read-back sees.
A person approves by removing it, and there is no `--no-plan-review` anywhere: approval is `backlog.mjs plan-review <id> off`, or deleting the line and
committing. Every gate that could execute the item reads the one flag and refuses with one sentence, `this plan awaits review` (`PLAN_REVIEW_REASON` in
`shared/agent.ts`, with hand-kept copies in `orchestrate.mjs` and in the execute skill's text, pinned to it by `test/agents-shared.test.ts`): the board's Run
button, the server's `plan` and `dispatch` ladder (an uncoded 409), the orchestrator's queue — which turns the item `ungroomed` with that reason, the way
`in-review` does, so no new verdict reaches the run's stages — and `backlog-execute`'s own refusal. The rung is `planReviewBlock`, always AFTER `inReviewBlock`:
an item carrying both says the PR, the stronger fact, since a PR means the plan was already approved and executed. Between the two sits `unvettedBlock` (#341), on a tracker item an outsider filed whose body no groom has pinned. The mark is read as the tool reads
`runner-fix:`, by PRESENCE: a `plan-review: yes` that silently did not gate would be the failure the mark exists to prevent. Where it is read matters on a files
project — the board reads the working tree, so a line deleted but not yet committed still disables Run (the conservative direction), while the tick and the
orchestrator read `<base>`, the tree an execute worktree is cut from, so approval there is delete-and-commit.

**What a tick never does** is the same list the spec's non-goals make, and each is a rule about who owns the thing: it never merges (`backlog-orchestrate` is
the only skill that merges into a base), never commits a groom, never promotes an idea, never rejects, never asks a question (a scheduled step has nobody to
answer, and an
unanswered question parks the whole tick), and never runs anything in the background (`claude -p` exits when the turn does). An item a tick failed on is
recorded by content hash and skipped until it changes, so one impossible item cannot take every night's slot; the hash covers the body and the keys a person
edits, never `updated:`, `started:`, `phase:`, `groomed-at:` or the counters, which every attempt rewrites.

## The only `started:` marker a tick clears is the one a killed tick left

**backlog-tick.** A dashboard job's `timeout:` kills the step mid-work, and a step that runs out of turns ends the same way: the lock stays, and the item may
keep a `started:` marker. The next tick that finds a lock older than `--lock-ttl` (default 180 minutes, comfortably above any sane job timeout) reads the
verdict recorded in it and, in EVERY case, records that item `failed` with the reason `killed at timeout` and releases the lock. The release is a claim, not a
delete: `claimStaleLock` renames the lock aside atomically and owns it only if the bytes it got are the bytes judged stale, so two ticks racing to recover one
lock — or one recovering while another has just written a fresh one — cannot both act, and losing that race is `busy: another tick`. Whether it also clears a
marker is a separate question with a narrow answer.

**One marker is provably the dead tick's own.** A `started:` line records WHEN, never WHO — a files project has no heartbeat, so liveness of a session cannot
be read at all — which is why, on a files project, ANY marker blocks the project, and why the exception has to be proved from the one thing the tick does hold,
its own lock. The proof is exactly three facts: the lock is stale, its verdict is `groom <id>`, and `<id>` in the main checkout carries `started:` with `phase:
groom`. Then, and only then, `decide` answers `recover` with `stop: true` and the skill runs `backlog.mjs stop <id> --abandon` on that one id, because the
interval was no one's work. That is the ONLY marker a tick ever clears; every other marker is a person's or another session's, and the project stays blocked
until they clear it. The tick would be making a decision it has no evidence for.

**Everything else is left, each for its own reason.** A tracker claim is never cleared: the proof above is frontmatter and a tracker item has none, and release
is not the tick's to force — the dead claim goes stale after 15 minutes (`CLAIM_LIVE_MS`) and the next claimant's `start` retires it, which is the claim
protocol's rule, not a takeover the tick decides. An execute's marker lives in `.worktrees/execute-<id>` (a PR-mode groom's in `.worktrees/groom-<id>`), which
the busy scan skips, and the `execute/<id>` or `groom/<id>` branch and worktree a killed one leaves keep the item off the candidate list anyway (`executeTaken`,
`groomTaken`); clearing a marker there would also be clearing it in a tree another
process may still own. An unreadable lock is removed and nothing else is done, since there is no verdict to act on. The shape is a deliberate asymmetry: the
tick recovers its own groom, because a groom writes into the main checkout the busy scan reads and a dead one would block the project for good, and it
recovers nothing it cannot prove.

## `tick.json` has exactly one writer, the server, and a file that cannot be read is never replaced

**The tick breaker** (spec: [2026-10-22-tick-breaker-design.md](../superpowers/specs/2026-10-22-tick-breaker-design.md)).
`~/.backlog-manager/settings/tick.json` (`$BM_TICK_FILE` to override) is `{ "haltAfter": <int>, "maxPlans": <int>, "maxPrs": <int>, "resetAt": { "<abs
main-checkout path>": "<ISO>" } }` — how many failed ticks in a row halt a project, the two caps a tick job applies when its prompt carries no flag (#378), and
when a person last Reset each one. It is the fourth file the server owns under `settings/` and it keeps the
relationship the other three have with their reader: the server writes it (`writeTickFile`, the only write path, behind `POST /api/ticks/config` and `/reset`),
and `tick.mjs` reads it (`readTickSettings`) for `decide` and `status`, while the server reads it only to answer `GET /api/ticks` and to merge its own write. It
lives under `settings/` for the reason `watchdog.json` does, though it is not a watchdog setting: that directory is the one read-write mount the container has,
and the tick home beside it is deliberately read-only to the server. One file holds the numbers and the resets because they have the same writer and the
same reader; `orchestrator-control/` is split per project only because its reader is per run.

**A file that cannot be read is never replaced, and it is a stricter reading than `jira.json`'s.** `jira.json` reads a parsed non-object as empty, because there
is nothing in it to lose. Here a person who has hand-edited their way to `[]` or `null` is an edit in flight, and reading it as "3, no resets" would silently
re-arm a breaker they had just reset — so an I/O error that is not `ENOENT`, text that is not JSON, and JSON that is not a plain object are all UNREADABLE, and
every surface says so rather than guessing. `POST /api/ticks/config` and `/reset` answer `409` naming the file and leave it byte-identical
(`TickFileUnreadable`, thrown before any write: rewriting from defaults would turn a stray comma into "3, no resets" with nothing on disk left to recover the
old values from); `GET /api/ticks` answers `source: "unreadable"` with the error and `haltAfter: 3` (the caps at 3 and 2) for display only, and the Settings
Selects are disabled with a hint that names the file; and `tick.mjs decide` answers `idle`, reason `<path> unreadable — fix or remove it by hand`, so NO project ticks until a person has
looked. That last one is the point of the rule, and it is a stop rather than a fallback because each fallback is wrong in the unsafe direction: a default N
would un-halt a project whose written N was 1 or 2, and dropping the resets would re-halt one a person had just cleared. Stopping is the `state.json` posture —
nothing runs, and nothing is lost. The Ticks page's own figures are unaffected, because they read `state.json`.

**The write is atomic, key-wise, and the server's only one into this system's state.** Temp file in the same directory plus `rename` — a `tick.mjs` reading
concurrently sees the old complete file or the new complete one, and the rename is the cleanup, so no temp file survives a write — merged over the current file,
`resetAt` key by key, so Resetting one project never forgets another's. Two concurrent POSTs are a read-merge-write with no serialisation and the later one
wins; that is accepted, `jira.json`'s precedent: one person, one board. A hand-edited `resetAt` in the future masks every record until the clock passes it,
which is a hand edit's own consequence. The server writes `resetAt` only as `max(now, the newest parseable at in that project's recent)`, because a container
clock running behind the host's would otherwise leave the newest failure "after" the Reset it was meant to clear.

**The server never writes the tick home.** `~/.backlog-manager/tick/` keeps exactly one writer, `tick.mjs` — the relationship the section above states — and a
Reset is a timestamp in `tick.json` PRECISELY so that nothing in this server has to write there: no `halted` flag, no cleared `recent`, no lock touched. The
server only reads the tick home, per request and cached nowhere (`$BM_TICK_HOME`, read per call so a test's override is seen), and a directory whose name no
`tick.mjs` could have written — one `decodeURIComponent` throws on, a relative path, or a name that does not re-encode to itself — is skipped, never a 500 that
blanks every project's row.

## A tick halt is derived from the records and the reset time, never stored, and only a person's Reset clears it

**The tick breaker.** A scheduled tick that keeps failing keeps spending: each failed execute or groom is a full headless session, and the per-item skip only
stops the SAME item being retried, so when the cause is the environment — a red base branch, a broken toolchain, a lost token — the next tick picks the next
item and fails the same way. After N failures in a row a project's ticks stop (`decide` answers `idle`, reason `halted: <streak> failures in a row (halt after
<N>) — reset on the board, Runs › Ticks`, and starts nothing) until a person Resets it.

**Nothing stores the halt.** The streak is derived from `state.json`'s `recent` on every read — groomed-ness and Board-versus-Archive are derived the same way,
for the same reason: a stored flag is a second fact that drifts from the first. Walk `recent` newest first and, in this order: an `at` that does not parse stops
the walk, checked FIRST whatever the outcome, so a corrupt record is "older than everything" and can neither extend a streak nor hide behind an `ok` it does not
have; an `at` at or before the project's `resetAt` stops it; `ok` stops it; `failed` counts; any other outcome neither counts nor stops, because none is written
today and a future one must not silently reset a streak. Halted is `streak >= haltAfter`. Consequences, each intended: lowering N below a streak halts the
project at the next `decide` and raising it un-halts, with nothing written either way; groom and execute failures count together, since the breaker is about the
project's environment and not the unit; `recover`'s `killed at timeout` is a `failed` record and counts; and `forget <id>` does not touch the streak, because it
drops `items[id]` and leaves `recent` alone — `forget` is the per-item retry, Reset the per-project one. With 50 entries kept and N at most 10 the window can
never be too short to see a streak.

**The rule has two copies, pinned by one table.** `skills/backlog-tick/tools/tick-breaker.mjs` (`streakOf`) and `server/src/tick/tick-breaker.util.ts` each
carry it, because a skill's `tools/` never imports from `server/` or `shared/` and the server never imports from `skills/` — the `pauseRequestEffective`
precedent. The guard against drift is a suite on each side holding the SAME `streakOf` table row for row (`tick-breaker.test.mjs`, `test/tick-breaker.test.ts`),
so changing the rule on one side fails the other side's tests instead of letting `decide` stop a project the board shows as healthy, or the reverse. "Parseable"
is `Date.parse` not being `NaN` in both, for the same reason.

**Only a person's Reset clears it.** There is no expiry: an environment that broke at 02:00 is still broken at 08:00 unless someone looked. Nothing clears it by
restart — nothing is held in memory — and a malformed settings file stops the project rather than clearing it (the section above). Reset is `POST
/api/ticks/reset`, a `resetAt` stamp for the project's main-checkout path, allowed in every state — halted or not, lock held or not — and it touches no lock: a
tick running across the Reset records after it, and if it failed the new streak is 1. N is one global number on the board's Settings, not per project; a
per-project override can come later without changing the file's shape much.

**Where `decide` checks it** is after the lock step and its `recover` branch and before any read of the world: stack down (tracker) → `busy` for a held lock →
`recover` for a stale one → `idle` halted → API reads → busy → execute or groom. A stale lock is still recovered while halted, because recovery is cleanup and
releases the lock, but no unit is chosen; the `recover` record can itself complete a streak, and the NEXT `decide` is then `idle`. A halted project costs one
tool call and no API traffic, and the check reads files only, so the breaker works with the stack down. `readState` moved up with the check, so an unreadable
`state.json` throws exactly as it did before, only earlier — no unit runs either way, so a broken file can never un-halt a project.

## A pause request is a file the server writes and the tool reads

**task-17.** Everything else under `~/.backlog-manager/` travels tool → server: `backlog.mjs` writes `registry.json`, `orchestrate.mjs` writes `run.json`, and
this server reads both and writes neither. The pause request is the one file that travels the other way — the server writes
`~/.backlog-manager/settings/orchestrator-control/<encodeURIComponent(project)>.json` (`{ runId, requestedAt, kind }` since bug-39 — see "A stop is the
control file's second kind" below; atomically, `$BM_ORCH_CONTROL_HOME` to override), and `skills/backlog-orchestrate/tools/orchestrate.mjs` reads it at its
two dispatch gates.

`POST /api/agents/pause` (`{ project, cancel? }`, origin-guarded, **independent of `BM_AGENTS`** and never calling the dashboard — a pause is a fact on this
machine's disk, and gating it on that switch would mean a run started while agents were on could never be stopped after they were turned off) writes
`~/.backlog-manager/settings/orchestrator-control/<encodeURIComponent(project)>.json` — `{ runId, requestedAt, kind: 'pause' }`, `$BM_ORCH_CONTROL_HOME` to
override. The `kind` key is bug-39's; **absent means `'pause'`**, so every file written before it existed goes on meaning what it always meant.

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
Date.parse(control.requestedAt) > Date.parse(run.unpausedAt ?? run.startedAt) &&
control.kind !== 'stop'
```

(The third clause is bug-39's, and it is what makes the two predicates DISJOINT rather than nested — `stopRequestEffective` is the same first two clauses plus
`kind === 'stop'`.)

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

## A stop is the control file's second kind, and nothing resumes a stopped run

**bug-39.** A pause is a cooperative request read at two dispatch gates; it stops a run at the next item boundary and it deliberately cannot strand
half-finished work. It is therefore invisible to exactly the run a person most wants to stop — a session that is dead, or forty minutes into a build, reaches
no boundary. The filing's own shape: a driver was killed by hand, `orchestrate.mjs abort` exited `7` ("is alive … and driven by session …") because the run
FILE was still fresh, and the watchdog resumed the run before the heartbeat could age out. Three mechanisms, and none of them a stop.

The missing thing was a per-run fact meaning **a person ended this run** — not on the wire, not in the control file, not in the run file, not in the
sweeper's inputs. This is that fact, in the one channel that already travels server → tool.

**`PauseRequest.kind` is `'pause' | 'stop'`, and absent means `'pause'`.** Every control file written before bug-39 lacks the key and means exactly what it
has always meant. One control fact per project stays ONE FILE: a stop overwrites a pause, a pause overwrites a stop, last write wins in both directions, and
pause's `cancel` deletes either — `stop` itself has none (bug-53, below). Two files would be two facts to reconcile and the reconciliation would be a third rule nobody reads. An unrecognised `kind` is
DROPPED rather than refusing the file, which makes it read as a pause — the safe direction, since the worst a misread stop can then do is stop at a boundary
instead of immediately.

**The two predicates are disjoint, on both sides of the boundary, and duplicated rather than shared** (a skill's `tools/` may never import from the server —
the same reason `pauseRequestEffective` was already duplicated). `stopRequestEffective` is the pause predicate's two clauses — `runId` pins the run,
`requestedAt` post-dates `unpausedAt ?? startedAt` — plus `kind === 'stop'`. A stop is NOT a stronger pause: if the pause predicate also answered `true`, the
run would take the cooperative path (`finish --status paused`) for a request whose whole point is that the cooperative path is not reaching it.

**`POST /api/agents/stop`** is `pause`'s sibling — `SameOriginPostGuard`, `@HttpCode(200)`, body rebuilt field by field, independent of `BM_AGENTS` (recording the fact must work on a machine whose launcher is off), and refused unless the project has a `running` run,
**fresh or stale alike**, because a stale `running` run is the case this bug is about — **or a `paused` one** (#305). A paused run's driver has exited, but
the run still holds claims, `orchestrator:queued` labels and parked worktrees that only an abort clears, and refusing it left two exits: a Resume spent only
so that a Stop could follow it, or a hand-typed `--abort`. Admitting it puts a stop on file for a run nobody is driving, which the board's Resume already
refused — so `orchestrate.mjs unpause` refuses an effective stop too, with exit `10` and nothing written, because an unpause stamps `unpausedAt` past the
stop's `requestedAt` and would retire it without a word. Where it differs: it then attempts ONE spawn, through the gate
`resume()` uses, of `/backlog-orchestrate --abort`.

**Recording the fact and ending the run are two outcomes, and only the first is guaranteed.** The response is
`{ stopRequested, abortSession, abortRefused }`, and a gate refusal or a spawn failure is not an error — the request is on disk, the sweeper is already
standing down on it and `abort` will already take the lease on the strength of it, so the refusal rides back in `abortRefused` naming the one command a person
can run instead. A 5xx here would tell a caller the stop did not land when the half that matters did. The tracker queue sweep that runs between the two
halves (the orchestrator:queued spec, §3.1) is a third outcome held to the same rule: a refused label removal adds its id to an optional `unqueueFailed` and
the stop proceeds, because the label is advisory and the `--abort` session repeats the sweep.

**A stop cannot be withdrawn, so it asks first (bug-53).** The route's `cancel: true` was copied from pause's along with the rest of its shape, and the board
drew it as a `Cancel stop` chip — but a pause is a REQUEST the run honours at the next boundary, so withdrawing it genuinely returns the run to where it was,
while a stop is an ACT that completes inside the request recording it: `stop()` awaits the `--abort` spawn before it returns, so by the time any withdrawal
could arrive the child is signalled and the worktree is going. Deleting the control file then restored nothing and read as an undo. So `cancel: true` is a
409, refused before the run is looked up, rather than dropped from the body — an old client still sends it, and a route that ignored the flag would read that
click as a second stop, a second `--abort` into a run already ending. The protection moved to the only place it can work, BEFORE the request: the Stop chip
opens `ui/Confirm`, which names the item it abandons and says the run cannot be resumed, and only its accept sends the POST.

**The spawn is unconditional, not "only for a stale run", and that IS the force stop.** If the real driver is alive, the abort session's `takeOverRun` write
evicts it: its next command hits `assertDriver`, exits `7`, and stops immediately. That is the lease working as designed rather than being worked around,
which is also why this route needs no pid for the driver and no kill channel to one.

**So one stop reaches a live run twice, and the TOOL — not this route — is where the two are reconciled** (bug-54). A live driver's `watch` returns `10` and
the driver runs its own `--abort`, while the spawned session runs another; before bug-54 nothing told them apart, `--abort` being exempt from the lease on
purpose, and on 2026-09-22 the spawned session read the driver's teardown in progress (`git status`: 51 deletions, no additions) as evidence about the
child's work. Gating the spawn here on a live-looking `driver.at` was rejected: the client draws no second Stop once `stopRequested` is true, so a driver
that dies between the skipped spawn and its next `watch` tick would leave a `running` run with a stop on file that no surface can end, and closing that needs
a re-stop control and a stale-stop respawn rule — three layers to save one redundant session. Instead `abort` marks the lease it takes
(`driver.aborting`, equal to its `at`), and a second abort from another identified session refuses with exit `7` on a mark fresher than `RUN_STALE_MS`, before
writing anything; one on a run already `aborted` is a one-line no-op `0`. A stop's `force` overrides a driver's lease and never an abort's, because a stop is
on file for both aborts. The same session, a hand-run terminal and a stale mark are the three exemptions: finishing your own interrupted abort, the person at
the keyboard being the authority, and an abort that died mid-way not locking the run for longer than any other lease does. There is no lock under the
read-modify-write; the two aborts arrive ~25s apart and a doubled abort stays safe, so a lock is not bought. `test/agents-stop.test.ts` pins the spawn
staying unconditional for a fresh run with a named driver, so a server-side liveness gate cannot come back without the re-stop control it needs.

**`stopRequested: boolean` joins `pauseRequested` on the runs payload** — mandatory, derived per request from the SAME single control-file read (which is what
makes the two mutually exclusive rather than merely usually so), stored nowhere, and `false` for a remote row. **Both sides read that one field; neither
re-derives it, and it is deliberately NOT a third input to `watchdogStoodDown`.** That predicate answers "will the sweeper spawn", and the board renders its
hand Resume on the same answer being TRUE — so folding a stop into it would offer a Resume on precisely the runs a person just stopped. One boolean on the
wire, read verbatim by two readers, is stronger than two expressions that agree.

**The coupling's biconditional narrows to an implication, and that is deliberate.** "The board offers a hand resume exactly when the sweeper will not spawn
one" holds whenever no stop is on file; under a stop, neither side acts. The set of runs offering a Resume is now a SUBSET of the set the sweeper declines to
spawn for, never a superset — which is the safe direction, and the only direction, since the hazard the coupling exists for is a second spawn.
`test/watchdog-coupling.test.tsx` and `test/watchdog-sweep.test.ts` each sweep `COUPLING_ROWS` a second time under a stop rather than growing a
`stopRequested` column: the answer does not vary by row, so a column would be one rule written out seven times.

**Three readers in the tool, three different refusals.**

- `stage` refuses **every** transition with exit `10`, nothing written — wider than the pause gate in both dimensions (every stage, and not only a
  transition). A stop is allowed to abandon a half-finished worktree; that is the whole difference between it and a pause, and `abort`'s existing
  marker-preservation rule (a worktree still carrying an in-progress `phase:` marker — in a tracker project, an item still staged `dispatched` (#265) — is LEFT
  IN PLACE with an `attention` entry) is what keeps that safe. The
  re-stamp exemption does not apply either: the pause gate exempts re-stamps so a live child always has its session id recorded, and under a stop the refused
  `--pid` call costs the kill nothing, because `cmdAbort` reads that child's pid from `<dir>/logs/<id>.pid` instead (bug-43 — the child is NOT already dead
  or about to be, which is what this sentence used to claim). Narrowing the gate to exempt a same-stage `--pid` re-stamp was weighed there and declined: a
  second pid source leaves the gate's one rule — every transition, no exceptions — intact.
- `watch` kills the child **by the pid it was given** and returns `10`. This is the one place in the system that holds a live child's pid, which is why the
  kill belongs here and nowhere else; it is never a pattern, and the signal is `SIGTERM` because the child owns a transcript `usage`/`denials` still read.
  The check runs BEFORE the tick's heartbeat write, so a run being stopped does not have its `updatedAt` pushed forward by the very tick that noticed.
  **What that early return must not take with it is the session id** (bug-50, the sibling of bug-43's null pid): the same tick may have just read the child's
  `system`/`init` event, and there is no later tick to read it again — `stage --session` never runs again and the run is ending (bug-52's abort harvest
  fills an empty field, but only from the first dispatch's `logs/<id>.jsonl`, never a retry's). So the
  stop path persists a freshly-discovered id in a write of its own, skipping the `updatedAt` bump rather than the whole write. The distinction is what the
  ordering was protecting: freshness is read by `takeOverRun` to decide whether an abort from elsewhere is refused, and a session id is read by nothing that
  branches, so recording it costs that protection nothing. The write is best-effort, like the `SIGTERM` above it — a run file that cannot be written is not a
  reason to withhold exit `10` from a caller whose child has already been signalled.
- `abort` may TAKE the lease. `takeOverRun(dir, run, force)` gained a **required third parameter, no default** — `runClaimBlock`'s rule for `starting`
  (bug-21), for the identical reason: a default would let a future caller silently opt out. `cmdAbort` passes the stop's verdict, `cmdClaim` passes `false`
  unchanged, so a resume can still never steal a live run. A recorded control-file request is evidence of a human act that passed the origin guard, which is
  exactly the evidence the tool has no other way to get — and deliberately not a `--force` flag, which every automated caller could reach for. It also
  un-strands the hand-run terminal: the refusal's condition is `driver.sessionId !== me` and a person typing the command has `me === null`. bug-54 added a
  **required fourth, `aborting`**, for the same no-default reason: `cmdAbort` passes `true` and its lease carries `driver.aborting`, `cmdClaim` passes `false`
  and its lease never does.

**Exit `10` is `6`'s sibling and not `6` itself.** A `6` means "stop at the next item boundary, then `finish --status paused`"; a `10` means "stop now and go
to `--abort`". Different commands, different endings, and a run that collapsed them would finish the very item a person asked it to abandon.

**`RunQueueItem.pid` exists because a stop whose driver is already dead must still be able to reach an orphaned executor.** `run.driver` is
`{ sessionId, at }` and a session id is not a process, so until this nothing anywhere held an address for the child. Written by
`stage <id> dispatched --pid <p>` through the same `applyQueueItemFields` path `--session` uses, from the pid SKILL.md §4 already writes to
`<dir>/logs/<id>.pid`. **Since bug-43 that file is the FIRST source and the field is the second** (`resolveItemPid`, beside `pidAlive`): the file is written
by the same Bash invocation that backgrounds the child, so it is the freshest address that exists, and the run file's copy is made one command later — a
command the stop gate refuses, which is precisely how a force stop's own run ends up with `pid: null` and a live `claude -p` child. Every failure of the file
(missing, unreadable, empty, whitespace-only, non-numeric, zero, negative, fractional) falls through to the field and none of them throws, because this runs
inside a teardown that must reach its worktree removals whatever it finds; the field is kept for the run whose `logs/` a person has cleared by hand. Reading
a PREVIOUS run's file is impossible: `archiveSidecars` moves the whole of `logs/` into `runs/<stem>/` at the next `init`, and `init` refuses any run still
reading `running`. The gate was deliberately NOT narrowed to let the `--pid` re-stamp through instead — that helps only the driver alive enough to make the
call, which is the less dangerous half, and costs a hole in a rule stated in one sentence. A pid that passes all three guards and is signalled is written
back to `item.pid` before `cmdAbort`'s single `writeRunAtomic`, so `signalledIds` stays reconcilable from `run.json` alone; one that FAILS them is never
written, since a wrong address is worse than none. `cmdAbort` signals it only when the item is non-terminal,
`pidAlive(pid)` holds, and `ps -o args= -p <pid>` names a `claude` process: the cheap guard against the pid-reuse TOCTOU `pidAlive`'s own comment documents.
That last guard's bias is the OPPOSITE of `pidAlive`'s, deliberately — a `ps` that fails or names something else is a decision NOT to signal, because the cost
of not killing is a stray process a person can find and the cost of killing wrongly is somebody else's work. Mandatory in the TYPE (the compiler is the
fixture checklist) and absent from every run file written before bug-39, which do not contradict: the one reader guards with `Number.isInteger` before it goes
anywhere near a signal.

**`abort` harvests the session id from `<dir>/logs/<id>.jsonl` the way it harvests the pid from the file beside it (bug-52).** The stop that lands inside §4's
dispatch block refuses the second `stage --pid` with `10`, so the driver goes straight to recovery and `watch` — until this, the only reader of the child's
`system`/`init` event — never runs. Every such run ended `sessionId: null` with the id sitting unread in a file the launcher had already written, and
`retro.mjs`, which resolves cost and transcript by that id, had nothing to resolve. `resolveItemSessionId` reverses `resolveItemPid`'s precedence, and the
reversal is the design: a pid file is rewritten by a relaunch so its copy is freshest, while a recorded session id was itself read out of a transcript this run
dispatched and cannot be superseded by the first dispatch's log — so the field wins whenever it is set, and the file is read only when it is empty. It runs
over the WHOLE queue, terminal items included, because an id is a record rather than an address to act on. Every failure of the file is "no answer", never a
throw, for the teardown reason above. `finish --status paused` was weighed and deliberately left out: a park is decided from `watch`'s own exits, so the
parked item's tick has normally already read the id, and one harvest at the exit that needs it beats a second copy on an exit that usually would not.

**The sweeper's own branch is an early return placed AFTER `fresh` and BEFORE the stand-down branch.** After `fresh`, because a stopped run still heartbeating
is a run whose driver has not noticed yet — it will, within one `watch` tick. Before the stand-down branch, because a stop is a stronger refusal than either
of those two: `off` and `exhausted` both mean "not right now, and a person may hand-resume", while a stop means "not at all, by that person's own request",
and reporting the weaker reason would invite exactly the click it is there to prevent. `'stopped'` is an eighth `WatchdogEventKind`, logged once per condition
behind `entry.stoppedLogged` — the ring buffer cannot answer "did I already say this". `AgentsService.resume()` refuses a stopped run with an **uncoded** 409
for the same reason the resume lock's does not carry `RUN_IN_PROGRESS_CODE`: that code is treated as a silent success by both callers, and this one needs a
person to cancel the stop.

**What was rejected, and why.** A sixth `RunStatus` (`stopped`): `aborted` already means "a person ended this run", and a second spelling would reach every
exhaustiveness site for no fact anyone could act on differently — the same reasoning that keeps `crashed` from being one. The server writing `run.json`:
flatly out, one writer. `abort --force`: available to every automated caller, including a confused `--resume` session, and it would reduce the lease to a
suggestion. The server killing the driver process: it has no pid and no kill channel, and it must never pattern-kill. Making `pause` bite mid-item: that is
what the two-gate placement deliberately rules out, and widening it would make every pause abandon a half-finished worktree.

## `backlog-orchestrate` is the only skill that merges into a base; execute and groom commit and push only in `pr` mode, and may arm GitHub auto-merge

Every other skill in this repo edits item files and nothing else, with one opt-in exception below (`pr` mode, execute's and groom's); `backlog-orchestrate` was
the first one to touch git history, and it is still the only one that merges into a base. It can, because of what it alone controls: `backlog-execute`'s "never
commits, never pushes" limit exists because an
execute session — headless inside a run, or by hand in the user's own checkout — runs inside a tree it does not own, and staging there could sweep up work that
has nothing to do with it — an unscoped `git add` in the user's own checkout is not a call any skill gets to make. The orchestrator's worktree is different by
construction: `orchestrate.mjs worktree <id>` (`git worktree add .worktrees/<id> -b backlog/<id> <base>`) creates a tree that holds exactly one item's work and
nothing else, so `add -A` inside it is safe in a way it never is in the main tree — the skill says so explicitly at the commit step rather than leaving the
asymmetry to be inferred. The commit itself is conventional-commit shaped, names the orchestrator as committer in the body (so `git log` never implies a human
read the diff before it existed), and lands on `backlog/<id>` alone.

The merge target is **derived, not fixed**. It is `git -C "<base tree>" merge --no-ff --no-edit backlog/<id>`, where `<base>` is the run's own recorded base
branch (`main` for a run that asked for nothing else) and `<base tree>` is whichever working tree currently has `<base>` checked out — see
[the merge happens in whichever tree holds the base](#the-merge-happens-in-whichever-tree-holds-the-base-and-the-run-removes-only-the-tree-it-made) for why that
tree has to be found rather than created. It is refused — parked, not forced — unless that tree is first verified to be on `refs/heads/<base>`; a run never
checks out a branch in a tree it does not own, either. No branch other than the run's base is ever a merge target, and no tree other than the one holding it is
ever committed to. Force-push and history rewrite stay off the table entirely.

**Push is no longer off the table, and the narrowing is exactly one sentence wide (task-47).** For a TRACKER project — and only for one — this skill pushes its
run's base: `git -C "<base tree>" pull --ff-only origin <base>` before each item's worktree, `git -C "<base tree>" push origin <base>` after each merge, and
`git push -u origin backlog/<n>` from the item worktree under branch mode. For a files project the orchestrator pushes nothing and publishing remains the user's
call, merge commits or otherwise. The only other pushes in this plugin are execute's and groom's `pr` modes, below — each its own branch only, never `<base>`,
in files and tracker
projects alike.

**Execute's `pr` mode commits and pushes, and it is this same argument applied to a tree execute owns** (the execute pr-mode spec). The limit above was never
"execute must not touch git"; it was "no skill stages in a tree it does not own". A hand execute session started with `--finish pr --base <ref>` (the sheet's
Finish picker, or typed into a terminal) finishes as a pull request, and it first makes the tree that limit asks
for: `.worktrees/execute-<id>` on `execute/<id>`, cut from local `<base>` — named so it never collides with the orchestrator's `.worktrees/<id>` /
`backlog/<id>` — or a linked worktree it starts in that is clean, on a named branch other than `<base>`, with no commits beyond it. That tree holds this item's
work alone, so `git add -A` there is as safe as in the orchestrator's, for the same reason. In it execute commits, has `backlog-reviewer` review
`<base>...<branch>` (at most two fix rounds), pushes `-u origin <branch>` and runs `gh pr create --base <base>` — and that is the whole of its git: never to
`<base>`, never a force-push, never a merge (the merge is the PR's, done by a person — or by GitHub, when auto-merge was armed below), and never under an
`[orchestrator-run` marker, where the run owns git and
the old limit holds unchanged. The mode is a trigger flag, chosen per run, rather than a committed file: a project-wide setting made every hand run a PR run
until someone edited and committed a file back, and what a person wants from one launch is not a fact about the project. The flag is composed server-side from a
validated field the way `--merge-mode` is (`AgentsService` appends `finishClause(action, finish, base, flags)` from the sheet's `finish`/`base` after the
editable body, and a body that spells `--finish` or `--base` is a 400 — a groom's too, and the auto-merge flags below), and an unknown or doubled `--finish`
stops execute rather than falling back to either mode, for the reason an
`unsupported` source never falls back to `files`. A permission-layer
denial of a git or `gh` step stops those steps and hands over the remaining commands; it is never retried another way. In a tracker project the pushed item then
carries the `in-review` label, which every per-item gate reads as `a PR is open for this item` — see [the eleven item-write
routes](#the-eleven-item-write-routes-are-guarded-refused-for-files-and-serialised-per-item).

**Groom's `pr` mode is the same argument applied to a third tree** (the groom-PR spec). A groom used to land on disk only — uncommitted, in the checkout it ran
in — so a spec and plan reached a base only when a person committed them, and a tracker project's plan sat on the issue with nothing to review. Started with
`--finish pr --base <ref>` (the sheet's Finish picker on the home machine, seeded from the `groomDefaultFinish` setting), `backlog-groom` instead cuts
`<root>/.worktrees/groom-<id>` on `groom/<id>` from local `<base>` — `<id>` with any leading `#` stripped, named so it never collides with the orchestrator's
`.worktrees/<id>` or execute's `.worktrees/execute-<id>` — writes the groom there, commits it in one commit, pushes that branch and opens one PR into `<base>`.
That tree holds this groom alone, so the narrow staging this rule has always asked for is as safe as in execute's. It runs no `backlog-reviewer` (a plan is
read as the PR) and never merges. A tick never passes a finish, so a tick's groom stays on disk, and `tick.mjs` skips `.worktrees/groom-<id>` when it scans for
a `started:` marker and treats an item with a `groom/<id>` branch as taken, so the next tick does not re-groom what a PR already carries.

**Arming GitHub auto-merge is not "the skill merging", and that is why the headline says "into a base".** `--auto-merge` (the sheet's Auto-merge toggle, seeded
from `prAutoMergeDefault`) lets either skill, once its PR is open and any claim released, run `gh pr merge <pr> --auto --<method>` — squash, else merge commit,
else rebase, whichever the repository allows, and nothing at all if `allow_auto_merge` is off — and wait up to 45 minutes, in the foreground, for GitHub to land
it. The arming waits on a `mergeStateStatus` read: `gh pr merge --auto` on a PR GitHub would already merge (nothing required pending — a repository with
auto-merge allowed and no branch protection) merges it at once instead of arming, so the skill arms at once only on `BLOCKED` or `BEHIND`, where GitHub gates
the merge, and elsewhere only once every check has concluded green — which keeps "merged once its checks pass" true on an unprotected repository; `--fix`
(`prFixDefault`, only beside `--auto-merge`) lets it spend at most three rounds repairing a failing check or a conflict with `<base>` in that time. The whole
procedure is `skills/backlog-execute/references/auto-merge.md`, one file both skills read, so the bounds cannot drift apart. The skill is asking, not merging: a
person ticked the box for this launch, GitHub performs the only merge into the base and only when the repository's own branch protection (required checks,
required reviews) is satisfied, and what the skill is forbidden is exactly what it was — a `gh pr merge` without `--auto`, a `git merge` into a base, a
force-push, an admin override. The one `git merge` the procedure runs, `git merge origin/<base>` in the fix loop, merges the base INTO the PR's own branch in
the skill's own worktree, which is the commit rule's tree and no base's. Every outcome reached after arming that is not a merge leaves auto-merge armed, so a
person's later push or approval still lands the PR without the session; not-allowed, refused and the not-armed exits arm nothing. Neither toggle is a trigger by
itself: `autoMerge`/`fix` are accepted only with finish `pr` (and `fix` only with `autoMerge`), and the clause that carries the flags is composed server-side
like the finish.

**A Jira Run's push is not a skill's, so it does not contradict this rule** (Jira repo/branch, spec §6). This rule is about this plugin's skills operating on
backlog items. A Jira Run started with **Open MR when done** ticked is told by its prompt to push its branch and open one merge request once the work is done:
that push is the spawned session following its prompt, in a foreign repository the board only maps, and only when the person ticked the switch — without it
the prompt still says "Do not push." No skill of this repo pushes there, and neither does the server, which writes no git at all
([the server never writes git](#the-server-never-writes-git)).

The reason a tracker project is different is not a change of taste: it is that the project is SHARED by definition. Its items are issues every machine reads,
so a merge that stayed on one laptop would be a run reporting `merged` for work nobody else can see — the same second-source-of-truth failure the whole
tracker-backed direction exists to remove. That is also why the push sits between the merge and `stage <n> merged`: the tool cannot see a push, so the close
is tied to the stage, and the driver calls it only once the push has succeeded.

**A rejected push parks and never degrades**, and it is the one place the classifier-denial rule does not apply. A denied MERGE degrades the run to branch mode
because nothing landed; a denied or rejected PUSH follows a merge that HAS landed, so staging the item `branched` would write a falsehood into the run file and
into the summary a person reads afterwards. See
[a classifier denial degrades the run](#a-classifier-denial-degrades-the-run-every-other-merge-failure-parks) for the rule this is the exception to.

**PR mode adds no fourth push.** A `pr` run's base is its run branch, so the same `push origin <base>` after each merge pushes that branch, and its per-item
pull is skipped. What it adds is one remote write that is not a git command: the finish's `gh pr create`, run by the driver in a Bash call of its own, which
opens the run's one pull request. The run still merges only into its own base, and never into the PR's target — a person merges the PR
([PR mode drains onto a run branch](#pr-mode-drains-onto-a-run-branch-and-opens-one-pr-per-run)).

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
is not "merge in a base worktree", it is **merge in whichever tree has `<base>` checked out** — resolved per merge by `orchestrate.mjs merge-check <id>` (a
`git worktree list --porcelain` scan, then both preconditions, then `baseTree: { path, created }` recorded on the run), into three outcomes that are
exhaustive:

1. **A tree holds it** — merge there. For a `main`-based run on an ordinary machine that is the main tree, so the resulting commands are byte-identical to the
   pre-`--base` ones except for an explicit `-C`.
2. **No tree holds it, and one can be created** — the run creates `.worktrees/_base-<sanitised ref>`, merges there, and removes it when the run finishes. The
   ref is sanitised (every character outside `A-Za-z0-9._-` becomes a `-`) because a branch name may contain `/`; the `_base-` prefix cannot collide with an
   item worktree, since every id `backlog.mjs` mints begins with `bug-`, `idea-`, `task-`, `ref-` or `oos-` and none begins with `_`.
3. **No tree holds it and one cannot be created** — park. This is the case that is easy to miss and the reason the resolution is not a single scan: a worktree
   **mid-rebase reports `detached`** in `--porcelain`, so the branch-line scan finds nothing, while git still knows that tree owns the branch and refuses the
   `worktree add` with `fatal: '<base>' is already used by worktree at '<path>'`. Measured. So outcome 3 is detected by the create failing, never by the scan,
   and the park detail quotes git's own message because it names the tree the scan could not.

**The run removes a base worktree only if it created it** — outcome 2 and nothing else, which `merge-check` records as `baseTree.created` (true only for the
worktree this run made, and once true it stays true) so that §10 and a resumed session read it from the run file rather than from memory. This is not a second
rule beside "authority stops at worktrees it
created itself"; it is that same sentence applied to a directory that happens to hold the base. A worktree the person made is theirs, however convenient it
would be to tidy up, and a run that removed one would be deleting a working tree its owner may have uncommitted work in.

**"The main tree" and "the tree holding `main`" are not synonyms**, and conflating them is the defect this whole section exists to prevent. The main tree is the
project's original checkout — the one the registry points at, the one `orchestrate.mjs` refuses to run outside of — and it stays the main tree whatever branch
it holds. The base tree is wherever `<base>` happens to be right now. On a default run they are one directory; on a `--base` run they are two, and every rule
below has to name the right one: the `symbolic-ref` precondition and the dirty-path overlap probe (both `merge-check`'s) follow the merge into the **base**
tree, because what can refuse a merge is the state of the tree being written to. A dirty main tree cannot block a merge that is not happening there.

**And so does everything that follows the merge — every cleanup command belongs in the tree that merge happened in** (bug-38). Two of them kept the pre-base
spelling, where `$PWD` was correct only because the base was always `main`: `git branch -d backlog/<id>`, and the `git diff --name-only HEAD^1 HEAD` that
§9's runner-fix pickup reads. Both are HEAD-relative — `branch -d` has no `--merged-into` and tests reachability from the HEAD of the repository it runs in, so
the invoking tree _is_ the parameter — and the project root's HEAD is `main` while the merge commit is on `<base>`. Both now run inside `orchestrate.mjs cleanup
<id>`, in the `baseTree.path` that `merge-check` recorded on the run; for a `merged` item with no `baseTree` it exits `1` before removing anything, because the
only alternative is the project root, which is this bug. Measured on run-20260918-081422: `error: the branch 'backlog/task-45' is not fully merged`, one line
after `Merge made by the 'ort' strategy`, for a branch `git branch --merged feature/tracker-backed` listed.

The leftover branch was the small half. The large half was the sentence attached to it, which told the driver a refusal proved the merge had not happened —
wrong in the direction that stops a healthy run, on every item of every `--base` run, since a driver that believes the merge failed has every reason to
re-merge or park an item already in the base. So the reading is now stated against the tree: a refusal **from the base tree** is real evidence of a missing
merge, a refusal from anywhere else is evidence only of a misaimed command, and `git branch --merged <base> | grep backlog/<id>` settles which before either is
believed — `cleanup` asks it on every refusal and reports the answer as `branchMergedIntoBase`.

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

A well-formed ref is not a shell-inert string, and since #343 both copies check that too, ahead of `check-ref-format`: the base must match
`^[A-Za-z0-9._/][A-Za-z0-9._/-]*$` (`BASE_BRANCH_SHAPE` in `base-branch.util.ts`, hand-copied as `BASE_SHAPE` in `orchestrate.mjs` and already held by
`tick.mjs`'s `REF_SHAPE`). Measured on 2026-10-27, `check-ref-format --branch` accepts `feat$(id)`, `a;b`, a backtick, both quotes, `&`, `|`, `<`, `>`, `!`,
`#` and `{}`, and the driver pastes `<base>` unquoted into its templates (`pull --ff-only origin <base>`, `push origin <base>`), so a collaborator's branch
named `feat$(cmd)`, fetched and picked, reached a shell. It is an allowlist rather than a denylist of metacharacters because a denylist is wrong the first time
it misses one, and the templates stay unquoted because every value that can reach them is now inert there. The Orchestrate sheet's picker filters by the same
constant, so it never offers a base the launch would refuse. The cost is that a real branch carrying `+`, `@`, `,`, `=` or `%` cannot be a base.

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
`git merge`. Dropping the clause made that rule cover the command SKILL.md issued then — until run-scoped bases put `-C "<base tree>"` back into the merge
(SKILL.md §9; the probe still has none), after which it matched no real merge again (#269). `server/src/agents/merge-check.util.ts` now judges a rule against
both shapes, and the Orchestrate sheet recommends `mergeAllowRules` (`shared/agent.ts`): `Bash(git merge --no-ff *)` for the probe and
`Bash(git -C "<project>" merge --no-ff *)` for the merges — the project's literal path, because a `*` before `merge` would also match git's `-c`. The quote
itself is left exactly as these three runs issued it.)_

Two consequences, and together they are the whole feature: merging is a _choice_ (a run that stops at four reviewed branches is a successful run), and a run
that wanted to merge and was refused _degrades to that outcome_ rather than parking work that is perfectly good.

The setting is chosen in a browser and consumed by a headless process on the machine, so it cannot travel by `localStorage`, and the run file already has
exactly one writer. It rides the one channel that exists — the spawn prompt — and lands in the run file, where every other fact about a run lives:
`orchestrateDefaultMergeMode` (client Settings, per-device, default `'merge'`, clamped by the same `pickOne` as `dispatchDefaultModel`) seeds the
`OrchestrateSheet` picker (and `executeDefaultFinish` — per-device, default `'in-place'`, clamped by the same `pickOne` over `EXECUTE_FINISHES` — seeds the
execute `LaunchSheet`'s Finish picker on every open, never from the last launch; `groomDefaultFinish` does the same for a groom's, below); the sheet sends
`mergeMode` on **every** launch, including when it equals the
default, because the field is the sheet's answer to
"what should this run do" and inferring it server-side from an absent field would put one decision in two places; `AgentsService` validates it and appends the
compile-time literal ` --merge-mode branch` (or ` --merge-mode pr`, below); `orchestrate.mjs init` writes `mergeMode`, `mergeModeEffective` and
`mergeModeNote`.

The service's rule differs deliberately from every neighbouring field. Absent (`undefined` or `''`) resolves to `'merge'`; a member of `MERGE_MODES` passes
through; **anything else is a 400, uncoded — not clamped, not dropped.** `model` and `effort` drop an unknown value because dropping one costs a default model.
Dropping an unrecognised `mergeMode` would resolve to `'merge'`, and _merging to `main` is the irreversible direction_: a caller bug must not be able to pick
it. Absent still means `'merge'` because absent is not a bug — it is every request written before this field existed. Uncoded because `RUN_IN_PROGRESS_CODE`
stays the one machine-readable answer this endpoint gives, and nothing about a malformed enum needs telling apart from another 4xx.

`MergeMode` (`shared/types.ts`) is `merge | branch | pr`, with `isMergeMode` as its one guard for the reason `isAgentAction` has one. `pr` came later and
has a section of its own, [PR mode drains onto a run branch](#pr-mode-drains-onto-a-run-branch-and-opens-one-pr-per-run).

Two run fields rather than one, because the archive has to answer "did this run merge, and was that the plan?" months later. `mergeMode` is what was asked for
and is never rewritten; `mergeModeEffective` is what the run is actually doing and only ever moves `merge` (or `pr`) → `branch`, never back;
`mergeModeNote` says why they
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
item, can find a branch a _previous_ run finished and left waiting on a hand-merge, confirm it with an archive-move probe (`orchestrate.mjs leftover <id>`
answers `archived` when the `<base>...backlog/<id>` diff moves the item to `done/`, and only for a branch with no worktree and no directory), and stage it
`branched` in the **current** run's own file without ever dispatching, reviewing or verifying it. This is deliberate — re-running that pipeline over
already-green work would spend a whole item's budget re-proving what a prior run already proved — but it does mean a `branched` entry in a run's history is not
proof that run executed the item, only that it correctly recognised the item was already done.

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
check already passed and the run simply finishes a delete git left half-done. `orchestrate.mjs cleanup` (`classifyWorktreeRemove`) is that rule's one home.

The preflight probe in `SKILL.md` §2 — `git merge --no-ff --no-edit HEAD`, once per run, merge mode only — is early warning for the same failure and never a
guarantee. Merging `HEAD` into itself prints `Already up to date.` and changes nothing that matters (no commit, no index change, no reflog entry, dirty tree or
clean — it does refresh `.git/ORIG_HEAD`, the same as any other `git merge`, harmlessly), and the command _shape_ is byte-identical to the real merge so the
classifier is shown what it will be shown later. It buys "find out in ten seconds instead of four hours" and nothing else: the verdict is per call, so a passing
probe can still be followed by a denied merge, which is exactly why the degrade path exists as well as the probe.

A tracker project's probe takes the tracker merge's own shape — three `-m` messages against `HEAD`, since that merge carries `Fixes #<n>` and a `Reviewed:` line
naming the approving report instead of `--no-edit` — and a resumed or unpaused session that has not probed probes before its first merge (#222). Both follow from
the probe's one job: a probe of a different shape, or none at all, asks the classifier nothing about the call that matters. The same incident fixed the other
half: **the merge is one Bash call of its own.** The classifier returns one verdict per call over the whole call, so a driver that chained `git merge …; git
push origin main` had a reviewed, green merge denied as `[Merge Without Review]` and degraded the run — a push question answered on the merge's degrade path,
when a denied push is meant to park.

## PR mode drains onto a run branch and opens one PR per run

release-kit's `main-pr-only` ruleset refuses every direct push to `main` — PR required, three CI contexts, linear history, no bypass actor — and a tracker run
pushes its base after every merge. Under the ruleset that push is refused, and a refused push parks, because the merge has already landed. So once a repo's
ruleset is on, every run there would spend one whole item and park at its push, the merge stranded on one laptop. `pr` moves the run's writes off the target:
the run drains onto a branch of its own, pushes that branch, and ends by opening one pull request into the base it was started against. It never merges that
PR. CI gates it and a person squash-merges it, which is the point of the ruleset. Design:
`docs/superpowers/specs/2026-10-15-orchestrate-pr-mode-design.md`.

**A third `MergeMode`, not a flag.** `pr` rides the route merge mode already travels — Settings default, the sheet's picker, `POST /api/agents/orchestrate`, the
spawn prompt's compile-time ` --merge-mode pr`, `init`, the run file, the claim — so every hop that validates against `MERGE_MODES` accepted it with no edit.
A separate `--pr` flag would have needed its own plumbing at each of those hops, and a refusal for the meaningless `--pr --merge-mode branch`. It also makes
the degrade free: a classifier-denied merge moves `mergeModeEffective` `pr` → `branch` exactly as it moves `merge` → `branch`, and `mergeMode` keeps `pr`, so a
degraded PR run stays recognisably one — it still skips the pull, and the items it merged before the denial still get their PR.

**Tracker projects only.** The server answers `pr` with a 400 for a project whose resolved source is not `github`, and `init --merge-mode pr` exits `1` there
with nothing written. A files project never pushes, a PR is a publish, and the one files project on this machine has no remote ruleset to route around. The
sheet offers the option only for a `github`-source project and falls back to `merge` from a `pr` Settings default on a files one.

**The run branch is the run's `base`, and the target is a new field, `prTarget`.** This is what made most of the feature free. Everything downstream already
reads `base` — §1's gate, §4's worktree cut, `merge-check`'s base-tree resolution, `cleanup`'s commands, `--resume`, the claim's `ClaimRun.base`, remote runs —
and each does the right thing once `base` names the run branch. The rejected shape kept `base` as the target and added a `runBranch` that every merge-side
reader would have had to prefer over it, which is a field each new reader can forget. `prTarget` and `prUrl` are **required** on `OrchestratorRun`, `null`
under `merge` and `branch`, so every literal that builds a run fails typecheck until it says so; an older run file's absent fields resolve to `null` once, in
`sanitizeMergeFields`, which also drops a `prUrl` that fails the GitHub PR URL pattern — the board's link-out does not rest on the tool alone, for the reason
`linkBase` is clamped.

**The run branch is minted, not chosen.** `backlog/run-<local date>-<n>`, `n` one more than the highest already used that day, read from local refs and from
`git ls-remote` — a tracker project is multi-machine by definition, and two machines starting a run the same day must not mint one name. The remote read runs
with a timeout and `GIT_TERMINAL_PROMPT=0`, and any failure falls back to local refs with one stderr line: it keys on the call failing, because the failure
modes worth falling back from are ones a config check cannot see. The branch is created with `git branch --no-track <run> refs/heads/<target>` as `init`'s
last git write, after every refusal, so a refused `init` leaves no branch. If a collision happens anyway, the second machine's first push is rejected and its
item parks, and the recovery is `--abort` and a fresh `init`, never `--resume` — the pull that would let a resume push again is the one PR mode skips.

**The issue closes at the item's merge into the run branch, not at the PR's merge.** `stage <n> merged --outcome` closes it after the push, exactly as in
`merge` mode, so the run branch is pushed after every merge rather than once at the end. Closing at PR merge would leave the item open after its claim was
released, and the next run would queue it again. The price: a PR closed without merging leaves closed issues whose work never reached the target. That is a
person's decision, and reopening the issues by hand is its fix — cheaper than a "merged but not landed" state every board reader would have to learn.

**The driver opens the PR; the tool composes it and records it.** `pr-draft` reads the run file and git, writes `<dir>/pr/body.md` and prints
`{ title, bodyFile, head, target }`; it refuses a run that is not `pr`, one with nothing `merged`, and one whose `prUrl` is already set. The driver asks
`gh pr list --head <head> --state open` first — a session that died between `gh pr create` and recording the URL left a PR the run file does not know, and
`gh pr view <head>` would also match a merged PR from an earlier run on a reused branch name — then runs `gh pr create`, and
`pr --url` records `prUrl` through `^https://github\.com/[\w.-]+/[\w.-]+/pull/\d+$`, refusing anything else and any run that is not `pr`. The tool makes no
GitHub call: the one network write stays in the driver's own Bash call, where a classifier denial or a refused `gh` is seen, and everything that decides what
the PR says stays in code a test runs. **A failed or denied `gh pr create` is not a park and does not change the finish status** — every item is merged, pushed
and closed, and only the PR is outstanding, so the summary names the branch and the exact command. No PR opens on `paused` (the run resumes onto the same
branch) or on `aborted` (a person tore it down, and an abort should not grow a publish step).

**Nothing merged: `finish` deletes the empty run branch, by compare-and-delete.** On every finish but `paused`, and so on every `abort`, which ends through
`finish`, a `pr` run with no item `merged` loses its local run branch — but only when `rev-list --count <prTarget>..<base>` is `0` and no worktree has the
branch checked out. The delete is `git update-ref -d refs/heads/<base> <sha it just read>`, which depends on no tree's HEAD; `git branch -d` from the project
root would judge "merged" against whatever the root has checked out, the HEAD-relative shape `cleanup` was rid of (see [the merge happens in whichever tree
holds the base](#the-merge-happens-in-whichever-tree-holds-the-base-and-the-run-removes-only-the-tree-it-made)). Either condition failing, or git refusing,
keeps the branch with one stderr line and never changes `finish`'s exit code: a merge that landed locally with its push refused has commits there that are not
`finish`'s to destroy. After a PR opens nothing deletes the local run branch — the repo setting deletes only the remote head — which is one reason the mint
reads local refs as well as `origin`.

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

**Ordering alone would buy nothing.** Every skill body and every `orchestrate.mjs` invocation in a run resolves through the plugin-root path the skill text was
loaded with — the installed plugin copy — while the merge lands in this repo's `main`, so a merged fix does not reach the run that merged it. SKILL.md §9's
"After a runner-fix item lands" (the mechanism is in `references/merge-failures.md`) is the within-run half: print `git diff --name-only HEAD^1 HEAD` **in the base tree** (bug-38 — `HEAD` there has to mean the
merge commit, and on a `--base` run the project root's is `main`), and if it names `skills/backlog-orchestrate/SKILL.md`, follow the repo's copy for the rest of
the run — plus the repo's `orchestrate.mjs` if that moved too. **Prose and tool move together or not at all**: following freshly merged prose while still
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

**The two sides list their files differently (#270).** The repo side hashes only what git tracks (`publishedDigests(root, { tracked: true })`, through
`git ls-files`); the install side walks its directory. The installer clones git, so what git tracks is the most an install can ever carry, and the dirty check
(`git status --porcelain`) cannot see an ignored file: walking the repo hashed a Finder `.DS_Store` under `skills/` into the repo's digest, so every sync
reinstalled, still differed afterwards, and exited 1 asking for a `plugin.json` bump. The install side keeps the walk because it is a plain copy with no `.git`
to ask, where any stray file really is a difference from what git delivered.

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

`plan-review:` (backlog-tick) is NOT a lifecycle key, and the invariant names it so nobody reads it as a third one. It is `runner-fix:`'s kind: a GATE on an
item, beside `groomed` (which stays derived exactly as before) and in no sense a status — a second answer to "which directory holds this file" is what the
`status:` ban refuses, and `plan-review: true` answers "may this be executed", a different question. A tick's groom writes it in the same write as the plan and
a person deletes it to approve; neither `start` nor `stop` touches it, and both round-trip it with every other unknown key. It is read by presence, any value
but `false` (trimmed, case-insensitive) counting, and on a tracker project it is the `plan-review` label instead.

`groomed-at:` (#322) is the third key the tool writes on its own, and like the other two it is never hand-written. `new` stamps it with `HEAD`'s sha for a bug
or task (a tracker body carries it as a `<!-- bm:groomed-at <sha> -->` footer line instead, which `body` keeps to exactly one), and a groom `stop` re-stamps it
— never an abandon, never an execute stop, never an idea or refactor, none of which changed a plan. It is an anchor, not a state: `drift` derives from it how
far the base has moved under the paths the plan names, and stores nothing.

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

## A new orchestrate rule enters `SKILL.md` as one statement; its story and its rare branches go to `references/`

`skills/backlog-orchestrate/SKILL.md` is injected whole into the driver's context and re-read on every turn of a run, and a run is a few hundred turns. The cost
of a sentence in it is therefore the sentence times the turns, whether or not the run ever acts on it. Two measurements, in characters of the body: the
2026-09-01 floor trim took it to **60,168**, and by 2026-10-05 it stood at **150,227** (151,246 bytes) — 2.5 times as large in five weeks. The growth was the
habit, not the rules: each new rule landed with the incident that motivated it written out beside it (the bug number, what the first version did wrong, the
measurement that proved it), each failure path landed inline in the section it interrupted, and each fixed sequence of repository and file checks landed as
prose the driver re-derived into commands every time. The run read all of it, all the time. `docs/superpowers/plans/2026-10-05-orchestrate-body-shrink.md` is
the shrink; this section is what stops the next one.

The three levers, and why exactly these three. **A story moves to `references/rationale.md`**, because the reader of the body needs the instruction and the
reader of the rationale needs the evidence, and they are different readers at different moments. **A branch a clean run never takes moves to its own
`references/*.md` file**, named in the body on a trigger the driver can observe, because only text that is _never read_ actually leaves the floor: a reference
the driver opens stays in its context for the rest of the session, so a file read in every run — a "reference per phase" layout — is the same bytes in a
different file plus the tool-call overhead of fetching it. That is also why the trigger must be an observable (a verdict, an exit code, a field of the
committed `backlog/source.json`) and reachable on both the fresh and the `--resume` entry path: a pointer the driver has to decide it needs is a pointer that is
skipped, and a pointer that sits in a section a resumed run never reads is not there at all. **A fixed sequence of commands becomes an `orchestrate.mjs`
subcommand** (`merge-check`, `leftover`, `worktree`, `cleanup`, `inspect`), because prose a tool call can replace is the one saving that costs nothing in
behaviour — and the sequence is then unit-tested against real repositories, which the prose never was.

Moving text is where a rule gets lost, so each statement the body keeps has a `[needle, rule]` pair in `orchestrate.test.mjs` and a guard keeps `bug-N` /
`task-N` / `#N` / run-id (`run-YYYYMMDD-HHMMSS`) history out of the prose, fenced blocks (``` or ~~~) exempt. The first fails by the rule's name when a later trim drops it; the second is what makes the convention checkable
rather than hoped for. What this section deliberately does **not** add is a size budget. The body's size is reported on every test run (`t.diagnostic`, never
an assertion) so growth is visible where the work happens, but a hard cap has compressed load-bearing rules away twice on this machine, and the one failure
this convention can have is a lost rule. When a target and a rule disagree, the rule wins and the target moves.

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

### Where a test file sits decides which runner executes it

The union above is a statement about the one word `pnpm test`; this one is about the file. Each runner finds its suites by a glob and nothing else — jest's
`testMatch` is `test/**/*.test.ts(x)`, `test:skills` is `node scripts/test-tmpdir.mjs skills/*/tools/*.test.mjs scripts/*.test.mjs` (a `node --test` launcher, #243) — so a test file runs if and only if its
path matches one of the three, and a file that matches none is not skipped in any way a gate can see: it is a file no runner opens, green by absence,
indistinguishable at `pnpm test` from a file never written. That has happened in its most literal form: `test:skills` was first spelled
`node --test skills/backlog/tools/`, node treated the bare directory as a module, and the script ran no tests at all (`e1f58e4`, 2026-08-26). The glob pair
is the fix, and it names files by shape on purpose — which is why placement is stated as a convention every session loads rather than left to the globs:
they cannot report what they did not match, so the path has to be right by construction.

"Flat in `test/`" is convention rather than mechanism — jest's glob would descend — and it is kept so that the two subdirectories that do exist,
`test/helpers/` and `test/fixtures/`, read as "not suites" from the path alone. The node side is the mirror image: `skills/*/tools/*.test.mjs` does not
descend, so there the same property is enforced rather than kept. `backlog-retro`'s suite is split in two — `retro.test.mjs` for the CLI, spawned as a child
process, and `retro-lib.test.mjs` for the modules under `tools/lib/` — and BOTH sit at the `tools/` level for exactly this reason:
`tools/lib/retro-lib.test.mjs` would read as the natural home, match neither glob, and never run, with no red anywhere to say so.

Cases that pin a skill's PROSE — `backlog-groom`'s stamp order and its closing `Groomed on disk only` line, `backlog-execute`'s pre-review checks and the
`agents/backlog-reviewer.md` half that reads them — have no suite of their own to sit in: those two skills ship a `SKILL.md` and no `tools/`, and `agents/` is
not under `skills/` at all, so nothing they own is within the node runner's reach. They live in `skills/backlog/tools/backlog.test.mjs`, which is within it,
rather than in a `tools/` directory invented to hold a test for a skill that has no tool. The `Groomed on disk only` cases go one step further and assert
`skills/backlog-orchestrate/SKILL.md`'s half of the seam in that same suite although orchestrate has `orchestrate.test.mjs` of its own, because the rule is
two skills agreeing on one sentence, and a suite that reads only one half is green while the halves drift apart; the reviewer/execute pair is the same shape.
Reading another skill's file as text is not importing it — no module edge is created — so the "one skill's `tools/` may never import another's" rule (the
reason `linkedWorktreeInfo` exists twice, in the registry section above) is untouched.

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
the same bind written with the host is refused `EADDRINUSE`. That overlap is a BSD-stack behaviour (macOS, where this was measured), not a universal one:
Linux refuses the wildcard bind itself with `EADDRINUSE`, so the two overlap cases run off Linux only, and on Linux a case in their place asserts the refusal —
a kernel that ever allowed the overlap goes red there instead of silently reopening this bug. Pinning the macOS quirk everywhere had turned every Linux
`pnpm test` red, which parked every item of an orchestrator run on the Ubuntu machine.

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

## A fixture date is relative to the clock the assertion runs under

bug-44. `pnpm test` went red on a clean `main` with nothing changed — three cases across `board-live-cards.test.tsx` and `dispatch-button.test.tsx`, on a tree
whose last commit touched none of them. The same failure had been seen the day before, noted in task-48's outcome as "a date-bomb in the fixtures", and nothing
was filed; by the time it was, every orchestrator run on this repo parked at `verify`, because `backlog-orchestrate` §8 makes that exit code the only thing that
green-lights a merge.

**The mechanism: two clocks that were never the same clock.** A fixture's `created` is an absolute literal, written the day the case was authored. The predicate
that decides whether the card renders at all reads the REAL clock — `useNow` inside `BoardView`, through `leavesBoard` → `isStale` → `lastTouched`. Nothing
between them injects an instant, so the literal is not a constant: it is an expiry date, `created + staleDays`, and the case passes only until the machine's
date crosses it. A fixture with `updated: ''` and `lastCommit: ''` falls to `lastTouched`'s third rung, ages past the default 30 days, leaves the Board for the
Archive, and the `getByText` that wanted its card starts throwing.

Which literals blow up is decided by the two escape hatches `isStale` already has, which is why only three of the many `2026-08-20` literals in this tree went
red: `leavesBoard` exempts `section: 'tasks'` outright, and `isStale` returns false for an item a fresh run holds (`runHoldsItem`). So the card that vanished
was `bug-14` at `merged` — terminal, therefore not held, therefore stale — and, in the other suite, `idea-1`, which no run mentions at all and which was the
deliberate control in both failing cases. The predicate was working exactly as specified; all five rules above were doing their job. The defect was entirely in
the fixtures.

**The rule.** `daysAgoDate` and `daysAgoStamp` (`test/helpers/dates.ts`) are the one home for a fixture date, and no `test/*.test.tsx` writes an absolute
`created`/`updated`/`lastCommit`/`started` literal outside the guard's allowlist. Both read `Date.now()` at CALL time rather than at module load, which is what
lets a suite install a fake clock in `beforeEach` and still get a date that agrees with it. Two functions rather than one because the shapes are not
interchangeable — a files item's `created` is a `YYYY-MM-DD` date, the other three are second-precision UTC stamps (and so, since #237, is a tracker item's
`created`, GitHub's full `created_at` — a fixture that needs one builds it from `daysAgoStamp`) — and the idiom had already been hand-rolled three times
before this file existed, spelled `daysAgoDate` in `board.test.tsx` (first shape) and `daysAgo` in `archive.test.tsx` and `dialog-escape.test.tsx` (second
shape). Two near-identical names returning two different shapes is its own trap, so the exported pair keeps the distinction visible. Same "one implementation"
rule `listenLoopback` follows one section above.

**Pinned by source guard, because behaviour cannot reach it.** `test/fixture-clock.test.ts` reads the source of every `test/*.test.tsx`, comments blanked first,
and fails on any of the four keys carrying a `YYYY-MM-DD` literal. A behavioural test could not be this guard: a fresh absolute date is green on the day it is
written and for thirty days afterwards, so the suite that introduces the next one passes every check on the way in — the same argument `supertest-bind.test.ts`
makes for reading source rather than measuring a bind. A red names the file and line, and the fix is a `daysAgo*` call or an allowlist entry with the reason
that literal is load-bearing. The allowlist is closed in both directions: an entry whose file no longer carries a literal fails too, because a dead exemption
would silently cover the next live one.

**Scope, both halves deliberate.** `.tsx` only — the `.ts` suites are node/unit tests that pass `now` explicitly (`item-age.test.ts`, `item-month.test.ts`), and
an absolute date is the clearer fixture there. Four keys only — a run stage stamp, a project's `createdAt`, a `polledAt` or a stage `anchor` never reaches
`isStale`, and a guard that flagged them would be routed around on its first red rather than obeyed. `test/helpers/store.ts` writes `created: 2026-08-20` into
real item files for the server suites and keeps it: staleness is derived in the client and the server never evaluates it.

**What the guard cannot catch, stated so a green is not over-read:** the pattern is a date literal written as a fixture VALUE, so a literal behind a name
passes. One exists on purpose — `board.test.tsx`'s `CREATED`, which is `<current year>-08-20` because the meta-line assertion pins the rendered string `aug 20`
and a moving date cannot produce a fixed month. It is safe only because that suite's default `updated` stamp outranks it on rung 1, never because of the name;
its comment says so. A name is a deliberate act with somewhere to write the reason, and the accidental literal is the one that has actually happened twice.

**Proved against a future clock, not just against today.** The conversion is only worth anything if it removed the class rather than resetting the timer, so it
was checked by running the jsdom suites under a throwaway `setupFilesAfterEnv` module that shifts `Date` 400 days forward: red before the change (the same three
cases), green after. The shim is deliberately not committed — a permanently shifted clock would be a third clock, and the guard is the durable half.

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

**The Jira clause (phase 5).** `POST /api/agents/dispatch-jira` cannot derive its action: a Jira issue has no file whose state says what comes next, so there is
nothing for `deriveAction` to read and nothing for a second implementation to drift from. The action is a PICK, and the rule's other half still holds — the
server never takes a string on trust. It is one of a closed set: the two built-ins, `execute` and `context`, and the skills `jira.json` holds right now. The
controller refuses anything outside the shape (`parseJiraAction`: `execute`, `context` or an object whose only key is `skill`, holding an `s_` plus eight hex digits id; anything else is a 400); the
service then proves a skill id against the file it has just read (`resolveJiraActionOrThrow`, 400 `unknown skill <id>`), before Jira or the dashboard is asked.
`GET /api/jira/prompt` runs the same two checks through the same function, so a preview and a Start refuse the same id in the same words. A skill's id is
read from the same file read as its prompt template, so a skill and its text cannot come from two moments, and a skill deleted between the sheet opening and the
Start is a 400, never a spawn with a stale template. The `repo` is the other field a Jira dispatch cannot take outright: it must be one of the paths `jira.json`
maps to the key's own project, compared after the same normalisation the writer stored it under, and only then handed to the dashboard gate, which is still the
raw string compare the sibling invariant describes — no `dirName` is derived from it.

## The orchestrate and Jira spawn prompts are composed server-side

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
tightest: each appends nothing or a compile-time literal selected by a guard, so no caller-supplied character reaches the prompt through either channel
at all. An `ids` entry is looser — caller text that passed a shape check and was then proved against a closed vocabulary. **`base` is the first and only member
whose caller-supplied text is appended verbatim**, which is why it is proved the way an id is (a ref-name check, then membership in this project's own local
branches — see
[the merge happens in whichever tree holds the base](#the-merge-happens-in-whichever-tree-holds-the-base-and-the-run-removes-only-the-tree-it-made)) rather than
clamped the way an enum is. Any statement here that every appended flag is a compile-time literal is therefore false and must not be restored: it was
true of two flags out of three and is true of two out of four. Each is appended only off its own guard, and each default appends nothing, so a request written
before any of these fields existed composes the byte-identical prompt it always did. The board's Orchestrate sheet can narrow a run to a subset of the queue, which means the
spawned session has to be told `/backlog-orchestrate task-3 bug-7` rather than the bare trigger — `--ids` is a flag `orchestrate.mjs`'s own `init` and `plan`
have always taken, and `SKILL.md` documents the trigger as `/backlog-orchestrate [ids…] [--max N] [--base <ref>] [--merge-mode branch|pr] [--question-mode decide]`. What makes that safe is that the server never _accepts_
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
(` --merge-mode branch` or ` --merge-mode pr` by `isMergeMode`, ` --question-mode decide` by `isQuestionMode`), with no caller string in it at all,
and each one's DEFAULT appends
nothing — `merge` there, `park` here — so a default run's prompt stays byte-identical to what shipped before either field existed. `pr` carries one more
check than its sibling: `resolveMergeMode` takes the project and answers a 400 when the project's resolved source is not `github`, before anything spawns.

The fourth is `base` (task-44), and it is the loosest of the four in form: it appends the caller's OWN text, ` --base <ref>`, where the other two append
literals. What makes it acceptable is that `resolveBase` proves it the way `resolveIds` proves an id — a ref-name check, then membership in this project's own
local branches — before anything is composed. Its default `'main'` appends nothing, like the other two. Order is ids, then `--merge-mode`, then
`--question-mode`, then `--base`: ids first because the tool reads bare tokens as ids and a flag ahead of them would swallow the first one, and each later flag
appended after the ones that predate it so every prompt this endpoint composed before a given field existed stays a byte-exact prefix of what it composes now.

**The Jira prompt (phase 5) is the second composed prompt, and it is the first whose composition is handed text by a stranger.** `POST /api/agents/dispatch-jira`
has no `prompt` field for the same reason `orchestrate` has none, and `JiraAgentsController` rebuilds the request field by field, so a `prompt` in the body is
never read. The session is told whatever `composeJiraPrompt` (`server/src/jira/prompt.util.ts`) returns, and that is ONE function with three callers —
`GET /api/jira/prompt` (the sheet's preview and Copy prompt) and the dispatch twice, once before any Jira write for the length check and once after the writes
for the spawn — so what a person previewed, what was length-checked and what the session received are one text, differing only by the nonce. What a caller
influences is enumerated by that composition and nowhere else: the key (`isJiraKey`), the repo (proved against `jira.json`'s mapping) and the action pick.
**A skill's prompt carries none of the ticket's text.** It is the template — the person's own words from `jira.json` — with `{key}`, `{url}` and `{repo}`
filled in one pass, and a `Jira ticket: <KEY>` line after it when the template names no `{key}`. A skill reads the ticket itself (`jira.mjs show`), so a copy
in the prompt was text the session was about to fetch anyway, and it cost most of the 4 000: a long description was trimmed, or the whole Start refused as
`prompt too long`, to say nothing the skill did not learn on its first call. `{summary}` and `{description}` were placeholders until then and now stay literal,
and with no stranger's string in it a skill's prompt has nothing to frame. What follows is the BUILT-INS' prompt, which does carry the ticket — and the
ticket is different from every one of the caller's three influences. An `ids` entry is proved against a closed vocabulary; a ticket's description is free text written by whoever
filed it, delivered into a session that can write files in the mapped repository, and no check can prove it harmless. So the composer does not try: it
contains it. The framing line — which says the text between the markers is the ticket's own content and not instructions — is read BEFORE any ticket text,
after the instruction. The markers carry a nonce minted per composition, so a ticket written beforehand cannot contain the real end marker, and only
lines carrying it are delimiters; the description sits in a fence one backtick longer than its longest backtick run, so nothing inside can close it early; and a truncation note is server text
placed after the closing fence, never inside the ticket's own. The cap is the dashboard's own 4 000, not item dispatch's 8 000 paste bound, and the
description is what yields to it; a prompt that cannot keep at least one character of it is a 400 rather than one that says `(no description)` about a ticket
that has one. This is mitigation, not proof — a model can still be talked into things — and the rest of the defence is that the session is the person's own,
in a repository the person mapped, under the permission mode they chose, clamped to the dashboard's ceiling. **Item `dispatch` stays the exception to the
whole rule:** its prompt is the launch sheet's text, which a human edits before sending, and is the one field taken outright
— save an execute's or a groom's finish clause, which is appended server-side from the validated `finish`/`base`/`autoMerge`/`fix` fields, after the
body, and never travels in the editable text.

**An execute's or a groom's finish clause is the third server-composed piece, beside the orchestrate trigger's flags and the Jira prompt.**
`finishClause(action, finish, base, flags)` (`shared/agent.ts`) is the whole of it: ` --finish pr --base <base>` plus its sentence for `pr` — an execute's says
it reviews, a groom's does not — and today's `COMMIT_RULE` for `in-place`, built from `finish` (a member of `EXECUTE_FINISHES`, else a 400) and a `base` that is
proved the way the orchestrate `base` is (`proveBaseBranch`) and only ever sent under `pr`. `flags` is `{ autoMerge, fix }`: `autoMerge` adds ` --auto-merge`
and an arm-then-wait sentence, `fix` adds ` --fix` and is read only beside `autoMerge`. Both are validated booleans, accepted only with finish `pr` (`fix` only
with `autoMerge`), so a lone `fix` or a flag under `in-place` is a 400 rather than a clause that lies; `false` is an untouched toggle and is accepted anywhere.
A groom names its finish only on the home machine — one sent to another machine has none, a 400. The plan's execute and groom prompts carry no closing clause at
all (`composePrompt` no longer appends `COMMIT_RULE` to a groom; `finishClause` does, byte for byte, under `in-place`), so the sheet's textarea holds the body
alone and the clause sits read-only below it: deleting ` --finish pr` from an editable box would otherwise silently turn a PR run into an in-place one. For
the same reason an execute or groom body spelling `--finish`, `--base`, `--auto-merge` or `--fix` (bare, quoted or backticked — a word character or hyphen on
either side is what spares `--finished` and `--base-ref`) is a 400 rather than being merged with the clause. An old client that sends no `finish` is treated as
in-place and gets `COMMIT_RULE` appended even if an execute's prompt already ends with it — a doubled sentence, harmless, and never a 400; a groom body's one
trailing copy is stripped first, so an old tab's groom sends the bytes it always did.

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
five blocks that leave a control on screen (the other four are a local skill session's `started:` stamp, an open PR, an outsider's issue no groom has pinned and a live run's claim — see the
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
promise in the spec and `.env.example` — with `BM_AGENTS` off the Board "renders exactly as it does today" and "shows no dispatch buttons" — literally true; do
not "improve" it into a disabled button on forty cards. "On the Board" is deliberate: the Jira card's `Run ▾` is the one stated exception, drawn with agents
off for the reason [the next section](#run--on-a-jira-card-is-never-hidden-for-the-dashboards-sake) gives.

The per-item blocks are the opposite case and keep their button. There are **five** of them, not one, and only the first is anything `dispatchGate` itself can
answer:

- **The dashboard cannot see this item's project** — `dispatchGate`'s own fifth line, the section above.
- **A local skill session already holds this item** — `progressBlock` (`client/src/lib/item-progress.ts`), and the only one of the five derived from the item
  file itself. It is the exact mirror of the block below it: `started:` has one writer (`backlog.mjs start`) and one clearer (`stop`), so a session grooming or
  executing an item states that in the frontmatter the board is already reading — `isInProgress` had been deriving it for the card's amber bar since before
  dispatch existed, and nothing ever wired that predicate into the dispatch path. For a files item it blocks on ANY stamp, fresh or stale, matching `start`'s
  own rule that any stamp refuses (a TRACKER claim is aged since #227: a stale hand claim no longer blocks, because the tracker's `start` retires it, while a
  stale claim held by a run or by the board's own dispatched session still does): a stamp nobody is behind is a lie the board must not paper over, and `stop` is the one-command fix for it. What stops an ancient stamp from
  blocking forever is `isInProgress`'s `status === 'open'` half — `move` never rewrites content, so an archived item's stamp is history rather than a claim. It
  lives in `item-progress.ts` and not in `shared/agent.ts` beside `runClaimBlock`, breaking that file's otherwise complete ownership of the block vocabulary on
  purpose: it is built from `isInProgress` and `progressLabel`, which are both already there, `shared/` must not import from `client/`, and hoisting the pair
  over would be a move made for a block the server has no use for. Client-only is the whole decision, not an omission — the board is the only surface that can
  double-dispatch, and the server's dispatch re-scan is unchanged. Unlike the run claim there is nothing here for the server to catch late: the skills already
  refuse (`start` will not stamp a file that carries a stamp), so what a second spawn cost was never a corrupted file but a wasted session and a refusal the
  user had to go and interpret — `backlog-groom` opening the whole "whose marker is this" conversation about a marker its own board set ninety seconds earlier.
- **A PR for this item is open** — `inReviewBlock` (`shared/agent.ts`), the execute pr-mode spec's decision 9: a tracker issue whose `in-review` label is on,
  mapped to `inReview: true`. Execute in `pr` mode releases its claim once the branch is pushed, and the issue stays open until the PR merges, so without
  this rung the item reads ready and a click starts a second execution of work already waiting on a reviewer. Unlike `progressBlock` it lives in `shared/` and
  the server reads it too — `plan` and `dispatch()` refuse with the same sentence, `a PR is open for this item` — because the label is on the tracker, where
  any machine's spawn can see it. A files item never carries the flag; its PR guard is a named known limitation.
- **An outsider filed this item and no groom has pinned its body** — `unvettedBlock` (`shared/agent.ts`, #341): a tracker bug or task whose author is not
  OWNER, MEMBER or COLLABORATOR, mapped to `unvetted: true` until a live claim of ours carries `pin` equal to the body's hash. It reads `UNVETTED_REASON`, and
  the server's `plan` and `dispatch()` refuse with the same sentence, for the same reason the open PR does: the mark is derived from the tracker, which any
  machine's spawn can see. It sits after the open PR, which is the stronger fact, and before plan-review, because a groom has to vet the body first.
- **An orchestrator run has already claimed this item** — `runClaimBlock` (`shared/agent.ts`), which reads the run payload rather than the item. It has to: a
  run works each item inside its own git worktree and nothing reaches `main` until the item merges, so while a run holds `task-7` at `reviewing` the `task-7`
  file `/api/items` scans on `main` looks untouched — no `started:`, no `phase:`, nothing `isInProgress` could key off. The item is not lying; it is telling the
  truth about `main`. Claimed means a stage in `RUN_CLAIMED_STAGES` (`shared/types.ts`) on a run that is _fresh_: the eight non-terminal stages, `pending` and
  `preflight` included, because a pending item is already the run's and a manual session that grooms or archives it first leaves the run dispatching into an
  item that moved under it. The seven exits (`merged`, `branched`, `failed`, `skipped`, `needs-answers`, `ungroomed`, `parked`) are out — the run is finished
  with the item, and a human picking it up by hand is the intended next move, `parked` most of all. That list is deliberately NOT `ACTIVE_RUN_STAGES` (client
  `lib/run-stage.ts`), which answers "does this card show a live stage badge" and correctly excludes `pending`/`preflight`; the two overlap by six members and must
  not be unified — both are built from `PIPELINE_STAGES` (`shared/types.ts`, #376), the one hand-written spelling of those six, so they share a source, not a list. This block is checked on the board and again in `dispatch()`, the second being the one that holds: the launch sheet fetches its plan once on
  mount, so a sheet left open while a run starts still shows an enabled launch button, and only the server sees the run as it is at click time.

`DispatchButton` reads all six in one order — environment-hidden, then project visibility, then the in-progress stamp, then the open PR, then the unvetted mark, then the run claim —
most fundamental first, so the reason on screen names the thing to fix rather than a symptom of it. With dispatch off or the project invisible there is nothing
worth saying about either kind of session that might hold the item. The open PR sits after the stamp and before the run claim because it, too, is on the item
this board renders, while a run claim is the volatile fact about another worktree. The stamp and the run claim are in that order for the same reason: the
`started:` stamp is
on the very copy of the item this board is rendering, while a run claim is a fact about another worktree that the next poll can change, so the file wins. They
coexist only pathologically — a run stamps `started:` on its own worktree's copy, which is exactly why `runClaimBlock` has to exist, so the registry's copy of a
claimed item normally carries no stamp at all — but a reader who has both is better served by the one they can go and look at.

This was bug-4: the run claim existed nowhere in the ladder, so a card an unattended run already owned kept a live dispatch tab, and clicking it spawned a
second session against an item held in another worktree on `backlog/<id>`.

The in-progress block was bug-12, the same shape one rung down and with the data in the opposite place: the card rendered its amber in-progress bar and an
enabled dispatch button side by side, one telling the reader a session held this item and the other offering to start a second one against it.

**One of the four lets the click through anyway, and only one: a project-visibility block re-asks the status instead of swallowing the click** (bug-13).
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
rather than a rewrite. Since #272 the hook has one caller, `GatedChip` (`client/src/components/ui/GatedChip.tsx`), which both controls compose: it owns the
rest of the disabled half too — which block shows, `aria-disabled` and the described reason — with the re-ask rule itself in `gateView`
(`client/src/lib/gate-view.ts`). What the hook deliberately does NOT own is the gate check: the two callers derive different answers (`dispatchGate(item, fresh)` versus
`projectDispatchGate(fresh, path)`) and have different sibling blocks, so folding the policy in would mean a config object per caller. The drift-prone half is
the mechanics — a hand-written copy that acts on the stale render, or drops the in-flight guard, looks right and is wrong. The Escape effect the four dialogs
each carried their own copy of read as one of the stateless idioms this repo repeats on purpose, right up until bug-23: two of those dialogs are mounted
together by design, so one press ran both callbacks. It is now `hooks/useDialogEscape.ts` — one stack, one listener — which makes it the same lesson as this
hook rather than the counterexample to it.

Three differences from the per-item case, each a consequence of the control being project-scoped rather than item-scoped:

- **More of its blocks hide.** `showOrchestrate` _hides_ the button for the environment ladder, for an unfiltered board (`projectValue === ALL` leaves the gate
  `null`) and for a project with a fresh run. The fresh-run rule must not be re-derived from a status refetch in any case: it comes from
  `useOrchestratorRuns`, which polls every 5s while any run is fresh and which a status payload cannot see at all. A rendered disabled button is blocked on
  project visibility, on sync-off (#17), or both — and until #272 it re-asked whenever visibility spoke, even beside sync-off, for an answer that could never
  open the sheet. It now follows the per-item rule through `gateView`: re-ask only when visibility is the ONLY block.
- **The project is captured at click time**, not re-read when the answer lands. The filter is a live `<select>`; the sheet has to open for what the reader
  clicked. There is deliberately no "the filter moved, discard the answer" guard: `orchestrating` is keyed on the project path precisely so a sheet outlives a
  filter change, and the window is one request wide.
- **The sheet cannot correct a stale answer in either direction.** `OrchestrateSheet` takes `spawnMaxPermission` alone rather than the whole `AgentsStatus`, and
  argues against re-running the gate's checks client-side; it calls `fetchMergeCheck` on open and nothing else. Its only server re-check is at **Start**, where
  the same gate runs server-side and returns an _uncoded_ 409 the sheet renders as an error and stays open on. That second half is not a defect to fix — it is
  the reason the fix could not be "let the sheet sort it out."

## Run ▾ on a Jira card is never hidden for the dashboard's sake

Run ▾ on a Jira card is never hidden for the dashboard's sake: Copy prompt is its second exit, and only Start hides. The Board's rule just above hides a dispatch
control whenever the environment makes dispatch impossible, and it is right there because on the Board dispatch is the control's whole job. The Jira card's `Run ▾`
(`components/jira/JiraRunMenu.tsx`, on every card and again in the issue modal's controls row) has a second job the environment cannot take away: it opens the
launch sheet (`JiraLaunchSheet`), and the sheet's `Copy prompt` needs the server's prompt composer and a clipboard, not the dashboard. A person with `BM_AGENTS`
off, or a dashboard that is down, still gets the one half of Run that works without it — the exact prompt a session would be told, framed and size-checked by
the server, ready to paste into a terminal of their own. Hiding the chip to match the Board would delete that for the sake of a consistency nobody asked for.
Spec §7 states it; this section is where the next person who "tidies" the two controls into one rule reads why they must not.

So the hiding moves down one level, to the one control that really cannot work. `JiraLaunchSheet` asks `projectDispatchGate(status, repo)` — the Board's own
ladder, called with the repository and not the item — and draws `Start` only for `enabled` and `disabled` (the latter titled with the gate's reason); a `hidden`
answer, which is the environment ladder, draws no `Start` at all, and neither does a sheet whose agents status has not landed yet, because a dead `Start`
enabled a moment later is a worse thing to look at than none. The gate is asked with `repo = ''` while no repository is chosen, on purpose: the environment
block is read before the path, so a `Start` is never drawn and then withdrawn the moment a repository is picked. `Copy prompt` is gated by nothing but the
preview: it waits for the prompt to load, and is absent only where the browser has no clipboard API, in which case the preview stays a selectable text.

Everything else about the chip is the per-item ladder in a smaller shape, decided in one place (`runChipState`, `lib/jira.ts`, read from the shell's status):
**no repository mapped** is a dashed chip that opens nothing and says where to fix it in its `title`; **a session already running on the key** is a disabled
chip, the live strip beside it being the reading; anything else opens the panel. The same reason that keeps a per-item block's button on a Board card — a block
you can fix is worth a control that says so — keeps these two on the card.

`JiraRunMenu` is also the seventh `Popover` composer (see the Escape section), and the sheet it opens is the seventh dialog: one component serves the card and
the modal because two copies would be two places to decide what "no repository" looks like.

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
not "a run.json exists"**, since `cmdInit` archives the old file and writes a new one, so a project that has ever run always has one. "A run in the same
payload" means `runs` alone, never `remote` (bug-57, withdrawing bug-51's widening): a `starting` mark is home's alone, because a board spawn into it can only
land on THIS machine (a launch sent elsewhere is `remoteStarting`'s, the next section) — the mark follows the local
dashboard's acceptance, the dashboard spawns in a path on this host, and `init` writes a local run file before anything is claimed — and `deriveRemoteRuns`
excludes every run id this machine holds a file for, so no remote run is ever the landing a mark waits for. Counting one evicted the placeholder of a live spawn
whenever another machine happened to start inside its boot, and a slow start then read as a launch that silently failed. Or the entry is older than
`RUN_STALE_MS`, the app's one freshness number, reused rather than joined by a second; or **a run for that project already reads `status: 'running'`, fresh or
crashed** (bug-21) — keyed on that status exactly, never on `!fresh` and never on "a run file exists", because `cmdInit` archives a `done`, `aborted`, `failed`
or `paused` file before writing the next one, so a project holding any of those can legitimately start a new run and must keep its placeholder. Rule 3 reads
LOCAL runs only, on purpose: it holds because `init` refuses a local `running` file, and another machine's run blocks no `init` here (two machines on one
tracker project must not block each other), so a remote run already in flight must not strip the placeholder of a local spawn that can still land — nor may one
that started after the mark, which is rule 1's half of the same argument. The accepted cost: a spawn that dies before `init` keeps its placeholder for up to
`RUN_STALE_MS` whether or not another machine is running (what bug-51 saw); retiring it early needs a signal about that spawn, not about anybody else's run.

Rule 3 used to be a render-time filter in `BoardView` guarding one thing (two strips for one project); it is server-side because the four gates below all need
it and the server's own lock can read it from nowhere else.

It is `mark`ed from `AgentsController` **after** the awaited spawn, beside `arm()` and for the same layering reason, so a failed spawn leaves no ghost; `runs()`
calls the pure `list()` and `OrchestratorController.runs()` calls the mutating `sweep()`, the same pure/mutating seam `annotate()`/`observe()` already keep,
both deferring to one shared predicate. Correctness never depends on the sweep — `list` re-applies all three rules every call, so an unswept map leaks at most
one entry per project and never lies, which is what makes `AgentsService`'s own direct `runs()` calls safe without one. There is no exception to that since
bug-57: every rule reads local runs alone, so a direct caller and the controller decide from the same inputs.

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
duplicated — which is exactly right here. (It was `StartingStrip` until task-37; the source-side half of this sentence lives in `hooks/useOrchestrateDraft.ts`'s own 409
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

## A launch sent to another machine rides in `remoteStarting`, never in `starting`

A launch sent to another machine rides in `remoteStarting`, never in `starting`. `RemoteStartingService` (`server/src/orchestrator/remote-starting.service.ts`)
is the remote counterpart of `StartingRunsService` and deliberately a SEPARATE map in its own payload field, not a second kind of entry in that one: `starting`
is read by `runClaimBlock` and by the local expiry rules (bug-21, bug-57), so an entry for a launch on another machine riding in it would block this machine's
own Orchestrate for a run that can never land here, and would be judged against local runs it can never match. It rides beside `starting` the way `remote` rides
beside `runs`, and for the reason bug-57 gave: what a mark waits for must be something only this machine's `init` can produce.

It is memory only, for `StartingRunsService`'s reason — an entry records a request THIS process made, which no file can answer, and the claim the remote session
writes is the durable trace; a restart costs only the `Starting on` badge for the rest of one launch. It adds no writer to anything.

It has TWO keys because the two launches block different things. A card dispatch is keyed by (project, item) and blocks a second launch of THAT ITEM on ANY
machine, home included: until the remote session's first claim lands nothing on the tracker says the item is taken, so every claim check a home dispatch reads
would wave a second session onto the same issue. That is intended — the block is the item's, not the machine's. A remote orchestrate is keyed by (project,
machine) and blocks only a second remote orchestrate of that project to that machine, never another machine and never home, because two machines may drain one
tracker project at once (the claim protocol keeps their items disjoint). So what a remote launch never blocks is a local RUN; what it does block is one ITEM,
for the minutes before its claim shows.

An entry dies on the first of: a claim by the entry's `host` (a copy of the machine's `host` taken at mark time, because the machine list is re-read per request
and an entry edited away must not be answered for by a lookup made later) is on the item, live or released, with a comment id above the entry's floor — the
highest claim comment id the tracker cache held for the issue at mark time; a remote run of that project on that host started at or after `requestedAt`; or
`RUN_STALE_MS`. The floor is what keeps an earlier session's claim from reading as this launch's landing. Released counts because a release edits the comment
and never deletes it, and a groom claims and releases inside one or two poll intervals: when the rule needed the claim LIVE, a sweep that missed that window
left the entry to age out, and for those 15 minutes it refused the item's natural next step, the execute of the item just groomed. A capture is never marked,
because it files a new item and never claims the one it was launched from, so nothing but age could retire its entry. Only `list`, which holds the remote runs,
can apply the second rule, and it deletes what all three retire, so the map is swept on every runs read. The launch-time `itemBlock` applies the first rule and
age — once a released claim retires an entry, an unswept one would refuse what no claim gate does — and `projectBlock` age alone, because the launch reads its
own live-run gate first and an entry the sweep would have retired but no read has yet refuses nothing that gate would not.

## `dashboards.json` has exactly one writer, the server, and a file that cannot be read is never replaced

**The machine list** (spec: [2026-10-22-multi-dashboard-design.md](../superpowers/specs/2026-10-22-multi-dashboard-design.md)). One board can start work on this
machine ("home", id `home`, the dashboard `BM_AGENTS_URL` names) or on another machine's dashboard (a "remote", id = its `name`).
`~/.backlog-manager/settings/dashboards.json` (`$BM_DASHBOARDS_FILE` to override, read per call and cached nowhere) lists the remotes and carries the person's
own presentation: `{ home?, dashboards: [{ name, url, bmUrl, host, account?, models?, efforts? }], order?, strategy?, threshold? }`. It is the sixth file the
server owns under `settings/` and it keeps the relationship `jira.json` and `tick.json` have with their reader, with one difference that matters: NO skill and
no tool reads it. The server writes it (`writeDashboardsFile`, the only write path, behind `POST /api/dashboards/entries`, `/entries/delete`, `/home` and
`/settings`) and the server reads it (`readDashboardsFile`) for `GET /api/dashboards`, the offers, the launch routes and the stop route — so what the file
decides is where THIS server will send a prompt that starts a Claude Code session, and that is why the four POSTs are guarded like every other agents POST and
why a name is held to `^[A-Za-z][A-Za-z0-9]{0,23}$`, unique case-insensitively, never `home`, at most eight.

**A file that cannot be read is never replaced, and a file that does not exist is the product as it was.** A MISSING file (ENOENT) is `source: "default"`: home
alone, no remote, and every surface the feature adds stays out of sight — `GET /api/dashboards/offers` answers home without fetching any usage, the client draws
no machine picker, and a request without `machine` is the launch it has always been, byte for byte. That is the promise the whole feature is built around: a
person who never creates the file never sees it. An UNREADABLE file — an I/O error that is not ENOENT, text that is not JSON, or JSON that is not a plain object
(`tick.json`'s strictness, not `jira.json`'s: a hand-edit in flight is not "no machines") — is `source: "unreadable"`: the reader answers home only and ignores
every remote it might have held, and the four POSTs answer `409` naming the file (`DashboardsFileUnreadable`, thrown before any write) and leave it
byte-identical. The stop is the point: rewriting from defaults would turn a stray comma into "no remotes" with nothing on disk left to recover the entries from,
and falling back to the last good read would send a launch somewhere the file on disk no longer says. A readable file is read forgivingly entry by entry — an
invalid entry, a case-insensitive duplicate (the first wins) and anything past the eighth is dropped, never an error — because a remote that cannot be
launched to is a card the person can see and fix, where a thrown error would blank the whole list. That repair is a VIEW, never written back (#349): every
POST edits the raw file it read and keeps every row and key it did not change — a dropped row, a shadowed duplicate, a ninth entry, a key this version does
not know — because the old write-the-view shape erased a person's hand-edited row the first time they saved an unrelated setting. `jira.json`'s writer
keeps the same contract.

**Tokens are env-only, and no response carries one.** A remote's token is `BM_AGENTS_TOKEN_<NAME uppercased>`, home's is `BM_AGENTS_TOKEN`, and neither is in
the file, the view or any error: `DashboardsView` carries `tokenSet` (a boolean) and `tokenVar` (the variable's NAME, so the card can say which one to set), and
an offer is built field by field from the machine so a machine's config, which holds the token, is never spread into it. This is the GitHub and Jira tokens'
rule applied to a third secret; the file is plain text a person edits and may paste into a bug report, and the variable is what a process manager already
keeps out of one.

**The write is atomic and the file's own.** A temp file in the same directory, then `rename`, the `tick-breaker.util.ts` shape — a reader concurrently sees the
old complete file or the new complete one — with the temp file removed when the write fails. Each POST is a read-modify-write of one field family (an entry, the
home block, the strategy), so editing one machine never forgets another; two concurrent POSTs are the later one wins, the precedent `jira.json` set: one person,
one board. The file never holds anything a machine owns: a remote's `host` is the value that machine's claims carry (its `BM_MACHINE_NAME`), recorded here only
so a stop after a restart can route by it.

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

That list has since outgrown those five, which is the point of keeping it there: `pause` and `stop`, the item writes, Jira's `dispatch-jira` (the second
session-starting POST) and its `jira-stop`, and the four `/api/dashboards` settings POSTs, guarded because they change which machine a launch may be sent to
and so are as guarded as the launch itself. The POSTs that list does not carry — Jira's `jira.json` and issue writes, the two `/api/ticks` writes and
`POST /api/trackers/sync` — carry the same `SameOriginPostGuard` and are pinned in their own route suites.

## Launch sheet model/effort pickers seed from Settings, never the last launch

`dispatchDefaultModel` / `dispatchDefaultEffort` (`client/src/lib/settings.ts`, mirroring the dashboard's own `spawnDefaultModel` / `spawnDefaultEffort`) are
per-device like every other key there, default to `''` — no pick — and are clamped against the same `MODELS`/`EFFORTS` the sheet renders, so a stored name can
never be one the selects cannot show. For the model, "no pick" does not mean the CLI decides: `AgentsService` fills `DEFAULT_MODEL` (`shared/agent.ts`, `opus`)
at both spawn sites when the request names no valid model, because a bare `claude -p` takes the host CLI's own default — Sonnet on this machine — and the
orchestrator's execute sessions were running on a different model from the driver the board launched. `backlog-orchestrate`'s dispatch lines and the reviewer
agent carry the same value literally, since neither can import from `shared/`; `test/default-model.test.ts` holds them to the constant. Remembering the _last pick_ stays rejected: a sticky `max` from last week quietly spending on a trivial
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

The execute sheet's Finish picker follows the same rule: `executeDefaultFinish` (per-device, default `'in-place'`, clamped by the same `pickOne` over
`EXECUTE_FINISHES`, so a stored `'merge'`, a number or a missing key reads as in-place) seeds it on every open and the last launch never does. Its Base select
is the one place the rule goes further — there is no stored base at all, because a branch name remembered from last week is a ref that may no longer exist, so
the select opens on the literal `main` and is sent only under PR.

A groom's sheet is seeded the same way by `groomDefaultFinish` (same default, same `pickOne` clamp), and the two PR toggles beside the picker by
`prAutoMergeDefault` and `prFixDefault` (booleans, default `false`, clamped by `pickBool`, so a stored string reads as the default). Fix only has meaning once
auto-merge is on, so Settings disables its row while `prAutoMergeDefault` is off — but the stored `prFixDefault` is left alone, and the sheet sends `fix` only
with `autoMerge`.

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
listener, installed on the first entry and removed with the last; all eight dialogs — the item modal (`board/ItemModal.tsx`), `LaunchSheet`,
`OrchestrateSheet`, since Jira phase 2 the Jira issue modal (`jira/JiraIssueModal.tsx`) and the Jira board sheet (`jira/JiraBoardSheet.tsx`), since the
release chip the What's new drawer (`ReleasesDrawer.tsx`), since Jira phase 5 the Jira launch sheet (`jira/JiraLaunchSheet.tsx`), and since the Dashboards
card stopped editing in place its add/edit sheet (`settings/DashboardSheet.tsx`) — are on it
and none binds its own listener. There were four until task-37: `RunDrawer` left the Board with the rest of the run's detail, which
is the Runs page's own sheet — inline, beside the list, never a dialog — so it is off the stack rather than migrated onto it, and `useDialogEscape` itself is
untouched. They used to bind four, unguarded, and two of them are mounted together by design — Board and Archive both keep the item modal open behind the launch
sheet — so one press ran both callbacks and took the modal with the sheet (bug-23).

Since task-40 the dialogs do not call the hook themselves either: the two overlay SHELLS do. `ui/Modal.tsx` is the item modal's, `ui/FormSheet.tsx` is both
sheets', and each calls `useDialogEscape` once, so a fourth surface opened through either shell joins the stack by construction rather than by remembering to.
The count was three while the shells had three composers, and `test/dialog-escape.test.tsx` mounts those three together to prove the ranking holds across
them.

Jira phase 2 is that construction paying out, twice. `JiraIssueModal` composes `Modal` — `Modal`'s composers are `ItemModal` and `JiraIssueModal` — and
`JiraBoardSheet` composes `FormSheet` beside the two Board sheets, so both joined the stack without a line of the hook changing, and the count is five. The
suite still proves the ranking on the Board's three; the two Jira surfaces need no case of their own, because what ranks them is the same shell code those
three run through, and a sixth composer of either shell would join the same way. A second modal is right where §8.7 of `.claude/DESIGN.md` used to say there
was one: the issue modal is the same sidecar reading — a facts column and a body — of a ticket instead of an item, and it holds no run state, so the reason
the run's detail is an always-visible sheet rather than a modal (a modal has no standing place for Pause and Resume) does not reach it.

The What's new drawer made it six through a THIRD shell. `ReleasesDrawer` composed `ui/Drawer.tsx` — a scrim and a right-edge panel, the dashboard's
releases drawer — and `Drawer` called `useDialogEscape` once, as `Modal` and `FormSheet` do, so the drawer joined by the same construction with no line of the
hook changed. Since #298 that shell is ui-kit's (`ReleasesDrawer` from release-kit's shared releases UI, spec D15), which owns no stack and by default binds a
`keydown` listener of its own — the exact two-listeners defect of bug-23. So the shape inverted for this one surface: the wrapper,
`components/ReleasesDrawer.tsx`, calls `useDialogEscape(onClose)` itself and passes `closeOnEscape={false}`, and ui-kit's drawer handles no key at all. It is the one dialog that opens from the rail, so it can land over any of the other five (an item modal left open, then the chip), and that is
the case the stack exists for: `test/dialog-escape.test.tsx` mounts the item modal and then the drawer and proves one Escape closes only the drawer, and its
stack case now mounts all six in order and hands the key down them one at a time.

The Jira launch sheet makes it seven, and through the same construction with nothing in the hook changing: `JiraLaunchSheet` composes `FormSheet`, which makes
`FormSheet`'s composers `LaunchSheet`, `OrchestrateSheet`, `JiraBoardSheet` and it — a fourth, as `JiraBoardSheet` was the third. It is hosted ONCE, in
`JiraView`, as a sibling drawn AFTER the issue modal, because `Run ▾` lives in two homes — a card and the modal — and the sheet they both open has to be the
later mount so that it is the stack's topmost entry by mount order: one Escape closes the sheet and leaves the modal, with no second listener to arrange it. The suite's six-deep case is not extended, for the reason Jira phase 2 gave: what ranks the seventh is the shell
code the existing cases already run through, and a launch sheet over an open modal is the Board's own `LaunchSheet` over the item modal, which the stack's
oldest case mounts.

The Dashboards sheet makes it eight, the same construction a fifth time: Settings' Dashboards card used to open its add and edit forms in place under the
row, where a seven-field form inside the list of machines read as more of the list, and `DashboardSheet` now composes `FormSheet` instead — its fifth
composer. It opens over nothing but the Settings page, so it ranks above no other dialog in practice, and the suite gains no case for it: it runs through
the shell code the existing cases already cover. The page's row-level `Remove` stays an inline `Confirm`.

One entry on the stack is not a dialog, and it is not counted among them. `ui/Confirm.tsx` (bug-53) is the confirmation the run's Stop opens — and, since #225, the item modal's claim release — drawn inline in
the row the click came from rather than over it — §8.7 of `.claude/DESIGN.md` keeps `Modal` to its two composers and nothing else floating but `Popover`'s
panels, which hang under their control without a scrim. The Jira board sheet's `Delete board` asks through it too, drawn inside the sheet, as do — since Jira phase 5 — the Skills card's `×` (`JiraSkillsGroup`, in its row) and
the issue modal's `Stop session` (in place of the chip). It calls
`useDialogEscape` anyway, because the rule is about who owns the key and not about what paints a scrim: a `window` listener of its own would fire beside the
stack's, and one press would close the confirmation and whatever dialog sat under it. It mounts when the question is asked, so it is topmost while it is drawn.

The second entry that is not a dialog is the popover, `ui/Popover.tsx` — the panel that hangs under a control, seven composers since Jira phase 5: the tracker
strip's (`TrackerPopover` in `components/TrackerChip.tsx`), the band's Filters and Sort, the Jira chip's (`JiraPopover` in `components/JiraChip.tsx`), the
Jira board's picker, the board sheet's roots search, which hangs over that sheet and so is the topmost entry while it is open, and `Run ▾`'s panel
(`jira/JiraRunMenu.tsx`, one composer drawn on the card and in the modal). It joins for the same reason
and in the same shape: it MOUNTS only while open, calling `useDialogEscape` once, so a popover opened over the item modal takes the key from the modal and hands
it back when it closes. What it does not take from the stack is click-outside — the stack owns a key, not the pointer, so `Popover` binds its own `pointerdown`
on `document` while it is open, ignoring a press on its panel and on the control that opened it (that control's click is what toggles it). The dashboard's
`useDismiss` bundles the two into one hook with its own `keydown` listener, which is exactly the second Escape owner this section forbids, and is why it was not
copied. Still eight dialogs counted.

Ranking is by **mount order**, a contract and not an accident: the entry's position is fixed for the dialog's mounted lifetime (registration effect keyed on
`[]`, `onClose` read through a ref rewritten every render), because every call site passes an inline arrow and an effect keyed on `[onClose]` would re-push the
drawer above the sheet on the next runs poll. Entries are removed by identity, never popped — a dialog can unmount from under one that is still open.

Module state rather than a context, the shape `lib/view-keys.ts` already uses: Board and Archive are separate lazy chunks and four suites mount these components
standalone.

Knowingly out of scope: nothing traps focus, so a drawer opened _after_ the sheet ranks above a sheet still painted over it — ranking by paint order would mean
a z-index registry.

## The strip's height and the well's gap are one token

The strip's height and the well's gap are one token, `--main-gap`, read by the strip and the Runs page — never a px literal (the tracker strip spec,
`docs/superpowers/specs/2026-09-28-tracker-header-strip-design.md`).

**Why the strip exists at all.** Since the redesign, `.main` carried a 24 px top margin and a 24 px top-left radius so the grey well would curve in where it
meets the white rail. It never showed: `body` paints `--board` too, so the margin was grey on grey and the corner was invisible. The strip is `.maincol`'s
paper — `--strip`, the rail's own token rather than a new one, because the point is that the rail and the strip read as ONE white L around the well — and the
well now begins exactly where the strip ends, so its radius is finally drawn against white. `body` stays `--board`: below the fold and behind a short section
the page is still the well's colour, which the rail's bottom edge expects.

**Why one token.** The same 50 px is three facts: how tall the strip is, where the well starts, and how much the Runs page must give up to fill the viewport
exactly (`.runs-board` is `100vh` less the two `--body-pad` gutters, and less the strip above `.main`). Three literals kept in step by hand is how a page
gains a scrollbar precisely the strip's height the first time someone retunes one of them. With `margin-top` gone from `.main` the strip IS the gap, so there
is nothing left to keep in step — design guard 9 pins that the token is declared twice and read twice.

**Why `0px` on the phone rather than a smaller strip.** Below 700 px the rail is already a top bar, and the chip moves into it; a second band under that bar
would be two headers stacked on a screen with no height to spare. So the strip is not drawn and the token is zero, which keeps `.runs-board`'s calc correct
there without a narrow copy of it.

**Why the chip has one home, not two copies hidden by CSS.** `App.tsx` picks the strip or the rail bar from the same `useNarrow` reading the rail uses and
renders the chip in exactly one. Two mounted chips would be two one-second `useNow` clocks and two popovers able to join the Escape stack — the second of which
would make "the topmost entry is the only one that closes" depend on which copy happened to mount last. A change of home remounts the chip, which is also what
closes an open popover instead of leaving it anchored to a chip that moved.

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
- **Its own code, never `RUN_IN_PROGRESS_CODE`.** That code means "a run is alive for this project, right now", which is false here: the run is crashed and a
  resume is on its way. Both callers treat that code as a silent success, which is the wrong reaction to being told to wait. The lock's 409 was uncoded until
  #268 gave it `RESUME_LOCKED_CODE`, because the watchdog has to tell "wait" apart from "refused" (next paragraph).

A consequence to leave alone: with `graceMs` at ten minutes and the lock at fifteen, the sweeper's second attempt is refused at t+10m (no attempt spent, grace
re-stamped) and lands nearer t+20m. That is correct — the first resume was still inside its own liveness window — and it is pinned by
`test/watchdog-sweep.test.ts`. What is NOT correct, and was until #268, is counting that refusal: it used to log a `failed` line and move bug-35's
`consecutiveFailures`, so at the five-minute `graceMs` floor and the default cap of 2 the refusals at t+5m and t+10m stood a run down as "stalled" after ONE
real attempt — the sweeper's own successful spawn spending its refusal ceiling. The watchdog now reads `RESUME_LOCKED_CODE` as "not yet": neither counter
moves and nothing is logged, and the next try is one grace window on. Raising `graceMs`'s floor to `RUN_STALE_MS` instead was rejected: it would move design
§5.2's default (ten minutes) along with the floor, and a run whose resume dies early would wait a quarter of an hour where five minutes is enough.

**Layer 3 — the driver lease in the run file.** The durable one, and the only one that can refuse a resume this app never asked for. Occurrence 2 was one
backlog-manager resume (`claude -p --session-id <new> … -n resume <project>`, this app's spawn) racing a dashboard session-resume
(`claude -p --resume <existing id>`, `buildSpawnArgs` in the dashboard's own repo). Nothing in backlog-manager requested the second, nothing here can see it,
and no lock this repo adds to its own server could ever refuse it. The run file is the one component both shapes reach.

`driver: { sessionId, at } | null` is written by `init` and by the new `claim` command and read by every mutating command; `status`, `plan`, `denials`,
`fix-mode` and `reconcile` stay unchecked, because an evicted session must still be able to find out what happened.
Identity is `CLAUDE_CODE_SESSION_ID` — the same id
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

**bug-35 keeps that half and adds the ledger it was missing.** "The cap counts successes only" is the right answer to an outage and the wrong answer to a
refusal that can never clear, and nothing in the original rule distinguished the two: a dashboard with remote answers switched off, a revoked token, a project
the dashboard no longer lists — each answers 409 forever, none of them starts a session, so `attempts` never moved, `watchdogExhausted` read false for as long
as the run stayed crashed, and the sweeper's only exit was unreachable. Observed as 17 identical `failed` lines over 5h20m, one every twenty minutes, a third
of the fifty-entry event ring spent saying the same thing while the crashed run they were about to save sat there unresumed and the `stopped`, `spawned` and
`recovered` lines that would have explained any of it were pushed out. The loop was stable rather than thundering — grace held it to one call per window — which
is why it survived a whole design review: it cost little and simply never terminated.

So a refusal now moves a SECOND counter, `WatchdogEntry.consecutiveFailures`, and `watchdogFailing(consecutiveFailures, maxAttempts)` is its derivation beside
`watchdogExhausted`. Three choices in that sentence are load-bearing. **Two counters, not one**, because a refused spawn starting no session is a fact about
cost: `attempts` is the number of live resume sessions this sweeper has launched, each one a real claim on the run, and a person who raises "Give up after"
after one genuine attempt and one outage must get the attempt they asked for rather than a slot an outage already spent. **One cap, not a second setting**,
because the number on that field reads "Give up after" and a person setting it to 3 has said how many times the sweeper may ASK — not how many of those asks
the dashboard has to accept for the number to mean anything — and it gives a stalled run the same re-entry an exhausted one has, through a control the operator
already knows. **A rung of its own, not a reuse of `exhausted`**, because `attempts` is 0 in this state and `exhausted`'s line would read "exhausted after 0
attempts — resume by hand": true, useless, and silent about the refusal that is the actual reason nobody is coming. `'stalled'` is a ninth `WatchdogEventKind`,
ranked last of the three rungs and logged once per condition behind `stalledLogged`, and its line carries `lastError` because the `failed` events that would
otherwise explain it are exactly what the next fifty events push out.

The counter is zeroed by anything that proves the run of refusals is over — a spawn that returned a session id, the run heartbeating again, a person's own
resume from the board — so a transient outage leaves no ceiling behind for the next crash. The `fresh` case clears it on the BRANCH rather than inside the
`recovered` guard: that guard needs `attempts > 0`, and a run of pure refusals has spent none, so the one state this field exists for would have been precisely
the state that never cleared it. `noteBoardResume` clears it for a reason worth stating separately — the stand-down exists to ask a person to act, and a person
who acts must not be asked again for the same reason the moment their resumed session takes its usual ninety seconds to heartbeat.

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
is what holds that, and it is written as an exact set precisely so a third caller cannot be added quietly. Its inputs are single implementations for the
same reason. `WatchdogStateService.spawningEnabled(config)` is the one answer to "may the watchdog spawn" — it fills the wire's `RunWatchdog.enabled` AND is
what the sweeper's own gate calls, rather than the sweeper re-testing `config.enabled` under an env check made separately in `sweep()`; that was the second copy
of a vocabulary, and CLAUDE.md's `isAgentAction` invariant already says which copy goes stale. And `exhausted` is **derived**, never stored — see below.

**bug-35 makes it three inputs, and `failing` is required with no default.** A default would be an opt-out: a caller that left it off would put the board back
to offering Resume on precisely the runs the sweeper stands down for, which is the coupling failing open — the one direction it must never fail in. The
compiler is what enforces that, and the one call site it was meant to break is `visit()`'s own object literal. The table in `test/helpers/watchdog-coupling.ts`
gained a `consecutiveFailures` column and three rows for it, the middle one being the bug's own state: three refusals against a cap of three with `attempts`
still 0, hand-checked `standsDown: true`, a verdict the shipped code answered `false` to forever.

**bug-39 narrows the biconditional to an implication, in the safe direction.** A stop request suppresses BOTH sides: the sweeper returns before it reaches
this predicate at all, and `RunControls` draws no Resume in any branch. So "offers a Resume" is now a SUBSET of "the sweeper will not spawn", never a
superset — the hazard the coupling exists for is a SECOND spawn, and a client offering none cannot cause one. `stopRequested` is deliberately not a third
input here: this predicate being TRUE is what makes the board offer the control, so a stop expressed through it would light the button up on exactly the runs
a person just stopped. See "A stop is the control file's second kind" above.

Pinned by two suites and one table, because no single `it` can hold both halves (one needs jsdom and a React tree, the other a real Nest app):
`test/watchdog-coupling.test.tsx` drives the predicate against every row of `test/helpers/watchdog-coupling.ts`, renders `RunControls` for a crashed run in each
row's state and asserts the Resume appears on exactly that row's verdict, and pins WHO reads `watchdogStoodDown` as an exact set.
`test/watchdog-sweep.test.ts`'s own table case arranges the sweeper for the same rows and asserts it spawns iff the row does not stand down. Each row carries a
hand-checked `standsDown` literal rather than a derived one: without it, both halves would assert only that they agree with `watchdogStoodDown`, which a
`watchdogStoodDown` broken into a constant would also satisfy — the two sides would move together and stay "coupled" while saying something false. Sharing a
fixture across suites is against this repo's usual convention, and is the point here: two copies of the table would be two copies of the rule. Each
suite also sweeps the same rows a SECOND time under a stop request, rather than the table growing a `stopRequested` column: the answer under a stop does not
vary by row, so a column would be one rule written out seven times.

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

The third file is `settings/tracker-sync.json` (#17, `server/src/tracker/sync-config.util.ts`), each connected repo's sync interval on this machine. It joins
`settings/` for `watchdog.json`'s reason — it is how eagerly THIS server asks GitHub, which no skill has anything to say about and which would differ between
two machines on one repo, so it cannot live in the committed marker — and it follows that file's posture point for point: read fresh, never cached, every
failure reading as the default (`15s`), one writer (`writeSyncInterval`, reached only from `POST /api/trackers/sync`), temp file plus rename. One departure
(#270): the WRITER refuses a file that exists but does not parse — a 409, the file untouched — because it rewrites the whole map, and rewriting from `{}`
would silently reset every other repo to `15s`; reading it as the default is harmless, replacing it is not. It is a map, not
a fixed object, so validation is per entry: a bad value costs its own repo its setting, never a neighbour's. No skill reads it; `backlog.mjs` learns of it only
through the 409 the server answers while a repo is `off`.

`settings/timezone.json` (#241, `server/src/settings/timezone-config.util.ts`) holds the one zone every device draws the board in. It joins `settings/` for
`watchdog.json`'s reason — a value a person sets from Settings, which a server-side write must reach — and follows its posture: read fresh, never cached, every
failure reading as the default (`null`, each browser's own zone), one writer (`writeTimeZone`, reached only from `POST /api/settings/timezone`), temp file plus
rename. It departs from `tick.json`, `jira.json` and `dashboards.json` on one point: a file that does not parse is REPLACED by the next write rather than
refused, because it holds one value and the write replaces that value whole — there is nothing a write could lose, and the person picking a zone is the repair.
No skill reads it.

Two switches guard `watchdog.json`, and they answer different questions. `WatchdogConfig.enabled` (the file's own field, read fresh on every tick) is the
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
It also polls while the payload's `remoteStarting` is non-empty (multi-dashboard): a `Starting on <machine>` row is cleared by the SERVER's rules, with no run
file of this machine's to tell the client, so without the poll the row would sit until something else woke it. It arms the same single coalesced request, never
a second one in flight.

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
`orchestrate.mjs usage <id> --jsonl <file>` is the one writer of `RunQueueItem.usage`, called at inspect time (SKILL.md §5, by
`orchestrate.mjs inspect <id>`, which composes `stage <id> inspecting`, this write and the `denials` count in one call, so it costs the driver no turn) and
again per retry or fix-loop transcript; `references/recovery.md` has a resumed driver pick up whatever the
crashed one missed.

One entry per transcript, never one summed figure — "the fix loop cost more than the item did" is a question an early fold destroys.

The identity rule is the trap: `claude -p --resume` keeps the session id it was handed, so an item's `<id>.jsonl` and its `<id>-fix-1.jsonl` report the SAME
session (verified against this machine's `task-22` pair), and keying idempotency on `sessionId` — which this task's own plan called for — would make a fix
loop's entry overwrite the execute session's. Identity is `kind` + `loop`, both derived from the file name the caller passed and neither guessable from content,
which also makes re-running the command over an already-recorded transcript harmless.

**Absence is a value here, at three levels**: no result event in the transcript writes no entry at all (a killed session was not free, and exits `0` saying so);
a numeric field a future CLI renames reads `null`, never `0`; and `usage` is optional on the queue item, so a run archived before this landed reads `null` from
`runUsageTotals`/`itemUsageTotals` (`client/src/lib/run-stats.ts`) and renders nothing at all rather than `$0.00`.

That is why nothing on the path from run file to view defaults it to `[]` — the detail sheet's row mapper (`rowsFromLive`/`rowsFromArchive`, `client/src/lib/run-detail.ts`) passes it through undefaulted where it defaults
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
`<base>` — `BASE_REF_DEFAULT` in `orchestrate.mjs`, i.e. `main`, unless the sheet's base picker (task-44) chose another branch and the board passed `--base`.
Since #254 the sheet asks this question at that same base (`?base=`, validated by `resolveBaseBranch` exactly as `POST /api/agents/orchestrate` validates the
run's own base, and defaulting to `main`); before it, the lookup still asked about `main` whatever was picked, so for any other base the note flagged the wrong
rows and `deselect uncommitted` dropped items the run would have executed. Every `main` in the rest of this section reads as "the chosen base". Those two
readings disagree whenever the file on disk is not the file at `main` — which is broader than one situation, and the breadth is
deliberate (see "one question, two fates" below). In the shape that prompted the task, the sheet previews a ready bug, `buildGatedQueue` reports
`not committed on main — the worktree this run creates from main would not contain <path>`, and the item is skipped — after the person has walked away from a
multi-hour unattended operation. The 2026-09-06 cross-run sweep counted five such skips across three projects (bug-12 twice in backlog-manager, bug-13 and bug-7
in claude-agents-dashboard, bug-16 in ixray). task-29 closes the other half of this at groom time, said by the skill that creates the state; this one is for the
person who groomed yesterday and is launching today.

### One question, two fates — and why the sheet has to say which

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
own goals. **Any surface that states a consequence of this flag must split it.** task-32's resolution split it by hedging — lead with the fact true of every
flagged row (the run reads `main`'s copy, not the file on screen), then name both fates whenever anything was flagged — because the endpoint answered only
membership. Since #235 it splits by data: the endpoint reports each row's fate (`absent`, the subset of `paths` that `main` does not hold, from the third read
in §3), and the note keeps the same lead sentence and then states only the fates actually on screen, each with its own count — the literal
`not committed on main` appears only when some row is absent, attached to the sentence that counts them, and a fate whose count is 0 is not mentioned at all.

The chip word stays the single term `uncommitted` across the chip, the `deselect uncommitted (N)` button, the endpoint and these docs, even though a
tracked-and-modified row is one whose _changes_ are uncommitted rather than the item. One vocabulary beats per-row precision here because the note directly
above the rows now defines the term outright; a chip reading `differs from main` would be more precise about one row and would leave the button and the endpoint
speaking a different language from it. #235 re-decided this when the per-row fate became knowable and kept the one word: the fate rides in the pill's `title`
(and the row's `data-fate`, for tests), never as a second visible word, and the note is where each fate is stated as fact. Forking the word would have left
the button and the endpoint speaking a different language from the rows for the same reason as before.

### 1. No memo — and specifically not the one in the next file over

`lastCommitDates` (`git-dates.util.ts`) sits beside this, does an almost-identical thing (spawn git, read something about `backlog/`), and is memoised. Copying
that memo here would be wrong in the worst available way: its key is the mtimes of `.git/index` and `.git/logs/HEAD` — the files git rewrites whenever the
answer to _its_ question, "when was this file last committed", can change. Editing an item file in the working tree, which is the precise event this module
exists to report, moves **neither** of them. A memo on that key would therefore answer "clean" forever after its first hit, reintroducing the exact false
negative the feature was built to remove, and it would do so silently — the sheet would simply stop flagging, which looks identical to a project with nothing to
flag.

The cost is affordable without one. Measured 2026-09-07 across the five projects in this machine's registry, the two original read spawns together took
50–270ms per project; #235's third read (`ls-tree`, §3) was re-measured 2026-10-02 on three of those projects at 4–9ms, with the whole call at 20–39ms warm —
and unlike `lastCommitDates`, which runs for **every** registered project on both `/api/items` and `/api/projects` (the two the board fetches on mount and on
every window focus), this runs for **one** project **once per sheet open**. That asymmetry is the whole reason one of these two functions needs a cache and the
other must not have one. The client half enforces the cadence too: the effect is keyed on `[project, base]`, so walking the three steps or flipping the mode
pickers re-asks nothing, and only picking a different base — which changes the answer (#254) — asks again.

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

### 3. Three git reads: two for membership, with an asymmetry between them, and one for the fate

`git diff --name-only --no-renames main -- backlog` finds tracked files whose working-tree content differs from `main`. It cannot find a file git has never
tracked — and a brand-new, never-committed item file is exactly that, which is the single most common shape of this failure.
`git ls-files --others --exclude-standard -- backlog` is the second read, and it is not belt and braces: verified 2026-09-07 against this machine's `ixray`, the
diff printed nothing and `ls-files --others` printed `backlog/bugs/open/bug-16-….md`, one of the five items the sweep had recorded as skipped. Case 3 in the
suite asserts the util's answer **and** that the diff-only answer is empty, so a later "simplification" down to one spawn cannot leave the case green.

The third read, added by #235, answers each flagged row's fate: `git ls-tree -r --name-only main -- backlog` lists every path `main` holds, once per request,
and a flagged path missing from that listing is `absent`. The fate is "does `main` hold this path at all", never "which of the two membership reads found it",
because neither read implies a fate: an item committed on a branch `main` does not contain is reported by `diff` and is still absent from `main` (case 4), and an
item `git rm --cached` from the index while still committed on `main` is reported by `ls-files --others` and is still present there (case 27). One spawn rather
than `cat-file -e main:<path>` per flagged row, because this runs on a request path and each read is awaited in turn. It carries `-c core.quotePath=false`
like the other two — an escaped listing would not contain a raw non-ASCII path and would misreport an edited item as absent (case 28).

A failure of _any_ of the three reads fails the whole question (`known: false`). Reporting the part that worked — paths without their fates included — would be
a confident, incomplete statement of fact about someone's repository, which is the one thing this render must never be.

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
- **`jira.mjs` (Jira phase 4) is the fifth, and takes the awaited shape on `backlog.mjs`'s argument**: one awaited `fetch` per request, each with
  `connection: close`, and nothing else asynchronous. Its suite pipes a 200 000-byte ticket through `show`'s stdout and expects every byte.

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
[idea-11](https://github.com/futin/backlog-manager/issues/94) (issue #94 since this repo's backlog moved to GitHub), stated so it is
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

Every file under `.claude/rules/` carries a `paths:` glob and is the **one home of the mechanism** for the rules scoped to it — CLAUDE.md keeps each rule's
headline and `Why:` link, this file keeps the reasoning (the 2026-09-22 split, below; until then the rule files were pointers into this file and CLAUDE.md
carried the mechanism). Both halves are load-bearing, and both were measured rather than assumed.

**Why `paths:` is mandatory.** A rule file with no frontmatter is loaded at `session_start`, in _every_ session, whether or not it is relevant — a permanent
context-floor increase on all of them. That is exactly what the rule files must not cost, so an always-loaded rule file is the one failure mode this mechanism
can introduce, and `test/claude-rules.test.ts` fails naming any file that has no non-empty `paths:` list.

**Why one home for the mechanism.** Three STATEMENTS of one rule was the drift the pointer design avoided: a rule file that restated a rule would have been a
third copy, free to drift from both CLAUDE.md and this file, and `backlog-execute`'s contract sweep would have had to visit it. Three TIERS is not that. Each
tier says something the other two do not — the headline that the rule exists and what it forbids, the mechanism how it is implemented, this file why — and
`test/claude-rules.test.ts` pins the seams: a rule file is bullets and nothing else, each anchored into this file exactly once; CLAUDE.md's linked headlines and
the rule files' bullets are one multiset with one home per anchor, headlines byte-equal; a linked CLAUDE.md bullet is a headline and a link, and any other one
is at most 80 words, so mechanism cannot creep back into CLAUDE.md by any door. Because tier two states contract, the contract sweep visits
`.claude/rules/*.md` — the one cost the pointer design declined, paid knowingly.

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
_before_ `Read`, so a session that follows this repo's own guidance can edit a file whose rule never fired. The rule files are a floor, not a guarantee —
CLAUDE.md remains the surface that every session loads unconditionally, which is why every rule's HEADLINE stays in it: a session that never loads the
mechanism still knows the rule exists and where it is read, the Invariants intro tells it to open the rule file by hand before editing through `Write` or
`codegraph_explore`, and the reviewer is told to read the matching rule files against every diff.

### The 2026-09-22 split

Measured on 2026-09-22, after `fb00e7e` (2026-09-07) had already cut every bullet to "statement, single implementation, contract numbers, link": CLAUDE.md was
540 lines / 71,333 bytes, and the desktop app's context panel priced the two CLAUDE.md files at 29.6k tokens with the global one about 1.5k of that — **roughly
28k tokens per session for this file**, before a word was typed. 430 of the 540 lines were the Invariants section; 66 of its 78 bold-led bullets ended in a
`Why:` link, and those 66 held 8,187 of the section's 8,456 words. Compression had reached the limit of its shape: what remained was mechanism, needed by the
sessions that edit those files and paid for by every session that does not.

The split moved each Why-linked bullet, as verbatim lines, into exactly one rule file — `orchestrator` 17, `dispatch-watchdog` 13, `board` 11, `items` 5,
`tracker` 3, `skills` 9, and three new scopes that no glob had reached: `security` 2 (the server edge), `scripts` 2, `tests` 3 — and left the headline and
link in CLAUDE.md. One duplicate (the `backlog.mjs` … `exit 5` rule, stated twice) was folded into its fuller copy after every backtick span and number in the
dropped one was proven present in it. After: **242 lines / 25,174 bytes**, roughly 9.9k tokens at the same bytes-per-token ratio — never measured; the move
below superseded it the same day. The nine rule files total 61,892 bytes and load only on a read of a file under their `paths:`. Left in place, deliberately:
the twelve unlinked bullets (each under 60 words) and the two plain Conventions bullets — among them the "tests are flat in `test/`" paragraph, some 330 words
of mechanism with no anchor to home it under, a candidate for a later move once it has one.

Later the same day the paragraph got its anchor — § "Where a test file sits decides which runner executes it", under the `pnpm test` union — and
moved into `tests.md` behind a one-line headline; guard 3 now caps a plain bullet at the same 80 words as an unlinked bold one, so the door it sat behind is
shut. CLAUDE.md after that move: **232 lines / 23,633 bytes**. Confirmed against the panel in a fresh session later that day: the panel's "Memory files"
line read **9,707 tokens**, and that bucket is the two CLAUDE.md files plus the auto-memory index — the global file (5,801 bytes) and the index (172 bytes)
account for roughly 1.5k of it, so **this file costs about 8.2k tokens per session**, down from ~28k. The bytes-per-token ratio moved from 2.55 to about 2.9,
because what left was the backtick-dense mechanism prose and what stayed is headline plus link.

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

`test/claude-rules.test.ts` reads `.claude/rules/*.md` and CLAUDE.md as SOURCE — no YAML parser, no glob library; the frontmatter under test is one inline
array a parser would hand back verbatim, and a multi-line `paths:` list deliberately reads as empty and fails the first case loudly, because nobody has proved
the loader accepts that shape. Six guards run over the real tree. Every file declares a non-empty `paths:`, because a rule file without one loads at
`session_start` in every session. Every `docs/subsystems/invariants.md#…` anchor a rule file cites resolves to a real `##`/`###` heading of this file, with the
slugifier itself checked against a heading known to round-trip, so a broken slugifier cannot pass by matching nothing against nothing. Every glob matches at
least one file _today_ — tracked or untracked-but-not-ignored, since a rule arriving in the same commit as the directory it scopes is the ordinary way a rule
arrives — because a pattern that matches nothing is a rule that never fires and fails silently forever; the matcher is hand-rolled over the three shapes the
files use (`dir/**`, which also names the directory itself, `dir/*.ts`, a literal path). Then the three tier guards the split added: a rule file is bullets
and nothing else, each citing exactly one anchor; CLAUDE.md's linked headlines and the rule files' bullets are the same multiset of (anchor, headline), with
one home per anchor; and a linked CLAUDE.md bullet is a headline and a link, while any other bullet — bold-led or plain, the plain shape since 2026-09-22 — is
at most 80 words. The parsers both tiers are read through (`test/helpers/rule-tiers.ts`) are pinned on string fixtures first, in the same file, for the same
reason the slugifier is: a parser that produced nothing would match nothing against nothing and pass every guard while asserting exactly zero.

"Passes on nothing" is now history, kept because the reason it changed is the point. Under task-35's pointer design the suite passed **vacuously** on an
absent or empty directory, and that was deliberate: P3 could have come back negative, in which case the correct deliverable was zero rule files and a recorded
negative, and a guard that went red in that world would have made the honest outcome look like a failure. The split changed what an empty directory means.
CLAUDE.md now carries only the headline of every Why-linked rule, and the mechanism lives in the rule files alone — so zero rule files is no longer "nothing to
guard" but "every rule's mechanism is missing", and the same-set guard says so, naming each headline it cannot find a home for. That is the one case that goes
red on an empty `.claude/rules/`; the others still pass on it, and `ruleFilesIn` still answers `[]` for an absent directory, pinned by one case, so an absent
directory fails at the guard that has something to say and not at a crash in the ones that do not.

## Settings is three pages, the page is the scope

`settingsScope` (`client/src/lib/settings.ts`) is `local | shared | dashboards`, per device, defaulting to `local`. **Local is everything in this browser's
`localStorage`; Shared and Dashboards are what the API reads off the host** — the watchdog's settings file beside the registry, `dashboards.json`, and the
environment the server was started with. No card mixes local and host, and the rail's sub-nav tree is the only thing that switches the pages, at every width.

### The rule is "the page is the scope", and one card had to split to satisfy it

Settings has carried a scope subtitle per card since task-39 — `this device`, `this machine`, `this server` — because the scope answers a different question
from the name: whether changing a setting affects anybody but the person changing it. Pages are that same answer moved up a level, and the move is worth
something only if it is true without exceptions. One card was not.

`Claude Agents` mixed backends. Its status lines and its `Setting it up` block report the HOST's environment — `BM_AGENTS`, `CLAUDE_BIN`, the dashboard's
remote-answer pill — while `Default model`, `Default effort` and `Dashboard link` were this browser's `localStorage` all along, sitting under a heading that
said `this machine`. That was tolerable on one page, where the subtitle was the only claim being made. It is not tolerable when the PAGE makes the claim too: a
card that mixes backends makes the band's scope pill a lie about half its own contents.

So the card divides. `Dispatch · this device` is the Local card holding the three per-device rows; `Claude Agents · this machine` stays on Shared carrying the
status row and the conditional setup block, and its status row has **no control in its right slot at all** — which is why `SettingsRow`'s `children` is
optional, and why the empty `.set-control` is not rendered rather than rendered hollow. Since multi-dashboard the Shared half is no longer a card of its own:
its status line and setup block are the Home row of `Dashboards · this machine` (`client/src/components/settings/DispatchStatus.tsx`), the card that already
listed this machine's dashboard as Home — the same subject, still the host's, so the split above is unchanged. When that card outgrew a card and became the
Dashboards page, the status line moved with it, into Home's detail, and Shared stopped drawing a dispatch line at all.

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

### Dashboards is the third page, and it is the host's scope like Shared

The machine list started as a Shared card, grew a per-machine detail (URLs, the claim `host`, models, efforts, a token fact), then a health dot and two usage
meters per machine, and a card holding a list beside a detail beside a Suggest control stopped being a card. It is a page of its own, so the pair the first
split argued from — local against host — is unchanged: Dashboards writes `dashboards.json` on the API host, so its pill reads `this machine` and nothing on it
is per device. Not a sub-section of Shared, because the rail's tree is the only switch and a second in-page level would be a second wording free to disagree
with it.

What the page reads is two requests that never wait on each other. `GET /api/dashboards` is the file (cheap, no outbound call) and draws the list and the detail
at once; `GET /api/dashboards/machines` is a health probe of every remote plus each machine's usage, up to two outbound budgets, and only colours the dots and
fills the meters when it lands (`checking…` until then). Folding the second into the first would let one dead remote hold the config page for 10 s; keeping them
apart is why a slow machine can only ever leave a dot quiet.

### There is no in-page switch, at any width

The dashboard this pattern was ported from draws a pill switch in its Settings band below 700 px. This board does not, and the difference is not an oversight:
the rail's trees stand open at that width, so the tree is reachable in one tap on the phone exactly as it is on the desktop. Runs' three pages already establish
the rule — task-38 deleted `runs-mode.ts`'s `MODE_BUTTON` pair along with the in-page control it named — and a second control here would be a second wording
free to disagree with the tree's. `test/settings-view.test.tsx` pins the absence, because "add a switch on the phone" is exactly the improvement a later reader
would make without knowing it was already decided against.

### The scope pill is the existing primitive, at `neutral`, on every page

`Band`'s right slot holds one `Pill` — `this browser` on Local, `this machine` on Shared and on Dashboards — and the WORD carries the distinction, not a tone. `PillTone`'s five
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

Jira phase 2 made it three call sites — Runs, Jira, Settings — and the third arrived exactly as the argument above says it should: a new item list
(`JIRA_PAGES`), a new current value (`useJiraPage`) and a new write (`setJiraPage`), with nothing about the markup restated.

The source-sections change made it five — Files, GitHub, Jira, Runs, Settings — the same way twice over: `FILES_PAGES` and `GITHUB_PAGES` for the item lists,
`useFilesPage` and `useGithubPage` for the current values, `setFilesPage` and `setGithubPage` for the writes, and still nothing about the markup.

### A source's own settings page may hold a host card

No card mixes local and host, and the page is the scope — but the scope rule is about Settings' three pages, not a ban on host cards anywhere else. GitHub ›
Settings holds one, `Sync` (each repo's sync interval, a host write through `POST /api/trackers/sync`), with a `this machine` pill in its band, for the reason
Jira › Setup holds `jira.json`'s writes: the control governs one source, and its home is that source's section, one tree entry from the board it changes. Shared
keeps the read-only report of every source this machine reaches, the `Sources` card, alone in its left column, against Watchdog, Tick and Time zone in its
right; its two links (`GitHub › Settings ↗`, `Jira › Setup ↗`) are the shell's pairs threaded down, and each is drawn only while the section it opens is drawn.

## The Jira section's two pages are switched by the rail's tree, and the section is drawn only when configured

The Jira section's two pages are switched by the rail's tree, or a link threaded down from it, never by an in-page control; the section is drawn only when
`GET /api/jira` says configured. The two halves are separate rules that happen to meet in one rail row, and each has a precedent or a failure behind it.

### The tree rule is Runs' and Settings', applied a third time

Board and Setup are two pages under one rail entry, which is the shape Runs (History, Watchdog, Ticks) and Settings (Local, Shared, Dashboards) already have, and the rule those
two settled is that the tree is the switch at every width: the rail's trees stand open below 700 px, so a segmented control on the page would be a second
wording of the same choice, free to drift from the tree's and reached in the same number of taps. Task-38 deleted Runs' in-page pair for that reason and task-42
never gave Settings one; a Jira page switch would have been the first thing a later reader removed, so it was never drawn.

The two links that DO land on a page — `Open board` on a Setup row, and `Open Setup` on a board page with no boards — are not switches in that sense, because
they are not a second implementation of one. `App` builds `onOpenJiraPage` once, the same pair the tree calls in the same order (`setJiraPage`, then the
shell's `change`), and hands it down, exactly as Settings' `Live view` link is `onOpenWatchdog`. A link built that way means what the tree entry means by
construction; a link built inside the page out of its own `localStorage` write and its own section call would mean it only until one of the two changed. The
page value lives in a module store (`hooks/useJiraPage.ts`, `useRunsMode`'s shape) rather than a `usePersistedState` per caller for the same reason Runs' does:
the tree and the page are two mounted writers, and a per-caller copy would leave one of them looking at the page the other has just left.

The chip's popover stays a reading with no link at all, for the rule's other face: a `Setup ›` link there would be an in-page switch on a surface that is not
even in the section. The Sources card's Jira row is the one surface outside the section that links in, and its `Jira › Setup ↗` is not a switch of its own
either: it is `onOpenJiraPage`, the shell's pair, threaded down through `SettingsView` and `SharedPage` (the Trackers row before it wrote `Jira › Setup` as
text), and it is drawn only while configured, since a link into a section the rail does not draw would open a page that falls on arrival.

### An unconfigured machine must not show an entry it cannot fill

A machine without `BM_JIRA_SITE`, `BM_JIRA_EMAIL` and `BM_JIRA_TOKEN` has no Jira section to show: every route but the status answers 503, so a rail row would
open on a page that can only say so, and on a machine that never configures Jira an entry that is always there and always empty is furniture that teaches
readers to ignore the rail. So the row is drawn while the status says `configured: true` and not otherwise, and the chip and the Sources card's `Jira › Setup ↗`
link follow the same answer.

What makes this harder than hiding a row is that the section can be STORED. `jira` is a member of `SECTIONS` unconditionally, because `resolveLegacySection`
runs in a `useState` initializer, before `GET /api/jira` has answered, and a list that refused `jira` there would throw away the section a reader left on a
configured machine on every reload. The conditional half therefore cannot live in the list; it lives in the shell, and it is decided by ONE answer. `App`'s
effect moves a `jira` section to the first drawn source row (`firstDrawn`, Runs when there is none) on `configured: false` — the only status that says there is
nothing to show — and on nothing else. An unknown status, whether not answered yet or every read so far failed, HOLDS the section, drawn in `JiraView`'s
`loading…` or `Jira unavailable` shape: a network blip at load says nothing about the credentials, and a shell that fell on it would move a reader off a working
section and record another section as where they were. A failure after a `configured: true` keeps that answer, because `useJira` keeps its last payload.

The rail follows the shell rather than the status alone: while the section is held, the row is drawn — a held section with no row of its own would leave the
reader on a page the rail does not name — and while another section is open and the status is unknown, it is not, because a row drawn on a guess and removed
on the answer would make the rail flicker on every load of every machine that never configures Jira. `Opens on` offers `Jira` under the
same answer, and a stored `jira` pin keeps its option so a native select never shows a value with no option; the pin itself is left alone and takes the same
fall at load, because the machine may get its credentials back.

## A source row is drawn only while a registered project has that source, and its pages are switched by the rail's tree

A source row (Files, GitHub) is drawn only while a registered project has that source, and its pages are switched by the rail's tree or a link threaded down
from it. The rule is the Jira row's twice over — the tree half from Runs and Settings, the drawn half from Jira — with the projects answer in place of the Jira
status.

### Why the rail splits by source

One Board mixed two write paths. A files project's items are files the skills write and git carries; a GitHub project's are issues this server writes through
the guarded item routes, with a claim, a sync interval and a cache age no file item has. In one well every reading had to say which of the two it was about, and
GitHub's one control — the sync interval — sat on Shared Settings, a section away from the board it governs. A row per source puts each write path under its own
entry, gives GitHub a Settings page beside its Board and Archive, and leaves Shared a read-only report of what this machine reaches.

### The tree rule, applied to two more sections

Files (Board, Archive) and GitHub (Board, Archive, Settings) are pages under one rail entry, so the tree is the switch at every width and no page draws one of
its own. The one link that lands on a source page from outside — the Sources card's `GitHub › Settings ↗` — is `onOpenGithubPage`, built once in `App` as
`setGithubPage(p)` then `change('github')` and threaded down, for the reason Jira's links are: a link built inside the card out of its own store write would
mean what the tree entry means only until one of them changed. The page values live in module stores (`hooks/useSourcePage.ts`) because the tree, the link and
the shell's own legacy-landing initializer are separate writers.

### The answer is the registry's, read once by the shell

Whether a row is drawn is a question about the registry, not the tracker. `ProjectsProvider` reads `GET /api/projects` once for the shell and hands
`drawnSources` out, rather than deriving it from `TrackersPayload.projects`, which knows only tracker-backed projects and would leave Files with no answer at
all. It reads on mount and focus and never polls — the registry moves on a `register`, not on a clock — and keeps its last answer on a failure, so a blip cannot
take a row away. An `unsupported` project and one with no source sit under Files as display grouping only, never as a source of their own: what they have to
show is file errors, and Files is the source with a place to show them. The index's `errors` are split the same way, by what each one names
(`errorSource`): every error the server sends starts with its subject, so a `gh:<owner/name>#<n>` URN — a warning about one GitHub issue — goes to GitHub, an
error starting with a registered project's path goes wherever that project is drawn (a github project's invalid-repo marker to GitHub, an `unsupported`
project's unreadable marker to Files), and only an error naming nothing registered falls to Files. Keeping every error on Files, as the first cut did, showed
GitHub's warnings on a page that does not draw their items — and on a machine with only GitHub projects, where the Files row is never drawn, nowhere at all.

### Three states, and hold-and-fall

Unknown (not answered yet, or every read so far failed) moves nothing: a section the reader chose is held, and the rail draws its row while it is the section on
screen, so a slow server never moves anyone and never leaves them on a page the rail does not name. A known answer that no longer draws the section on screen
falls it, through `change`, to the first drawn row — Files before GitHub, the rail's own order — or to Runs, the section that needs no project. The effect is
keyed on the state, so a focus reload that drops the row (a repo disconnected on another machine, the last files project unregistered) is the same case as a
first answer that never had it.

### The provisional landing

A machine with no stored section, or one that stored a root `board`/`archive` from before the split, has no section the reader chose. `resolveLegacySection`
gives it a PROVISIONAL GitHub — the one value that needs no answer, and today's Board is GitHub › Board — and the shell paints the loading shape, neither the
row nor the board, until the first projects answer settles it once: a page-named landing goes to GitHub when this machine has a GitHub project and to the first
drawn source otherwise (`settleSection`), anything else to `firstDrawn`. Drawing the guess instead would flash a GitHub row and board on every load of a
files-only machine before taking them back. A legacy `Opens on` pin is rewritten to where it settled: left as the clamped `github`, the next `update()` — any
Settings change — would store it as a real GitHub pin, and that machine would draw a held GitHub row on every load with `Opens on` naming a source it does not
have. A click made before the answer clears the provisional mark, so the settle never yanks a reader back. An old `?section=board` deep link names no section
and is ignored, like any unknown one.

`Opens on` offers Files and GitHub under the same answer (`landingOptions`), keeping a stored pin's option so a native select never shows a value with no
option; the pin itself takes the fall at load.

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
served build whose theme script the browser refuses to run: the page paints in the `:root` palette (Midnight) at 100%, even for a Daylight default,
on every load, and **nothing in dev shows it**, because dev has no CSP (see `security.ts`'s own comment for why the policy is a response header rather than a `<meta>` tag). `test/csp.test.ts` recomputes the
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
`GET /api/trackers` is what the Sources card and GitHub › Settings read, and it carries `hasToken` and a `login` — whether a credential is loaded, and whose —
because those are what an operator needs in order to know the right one is in place. `test/tracker-items.test.ts` asserts the value appears in no response of
any route this module serves.

**`docker-compose.yml` passes it through as an interpolation with a default, never a literal** — bug-25's rule, applied to a variable where the stake is higher.
A literal `BM_AGENTS: 'on'` was a wrong default; a literal token would be a credential committed to a repository, and the fix for that is revoking it rather
than editing the line. Pinned by `test/compose-env.test.ts`, which also asserts the key compose uses is the constant the server reads
(`GITHUB_TOKEN_ENV`), so a rename that missed one half fails here rather than on a machine with a token set.

**Outbound calls go to one constant host.** `API` in `server/src/tracker/github.client.ts` is the only host any request this module makes can
reach (`jira/` keeps its own host rule, stated in its token section below), nothing in a request shape names a host, and `repo` is validated (`isRepo`,
`owner/name` over GitHub's own character set) before it is interpolated into a path. A repo string arrives from a marker file someone
committed, which is not a trusted input just because it is not a request body.

**Armed, idle, off — the watchdog's shape, for the watchdog's reasons.** `TrackerPollerService` is a `setTimeout` chain, never a `setInterval`: the next tick is
scheduled after the current tick's awaits complete, so two ticks can never overlap by construction, and a tick waiting on a slow `api.github.com` can never be
re-entered by its own successor with two syncs racing for one repo's cache. It arms only while at least one registered project resolves to `github` AND a token
is present, and disarms on the tick that finds either half missing. A standing interval against a registry where nobody has connected anything is exactly the
cost the watchdog's own rule exists to refuse — and this loop would make HTTP requests rather than directory reads. `arm()` is called from the bootstrap hook
and from `GithubSource.list`, which is reached precisely when a project resolved to `github`: the cheapest honest signal that something is connected, and the
reason a repo connected after boot is polled from the first board read that touches it.

**Since #17, "connected" means connected and on.** Each repo has a sync interval (`15s`, `1m`, `5m`, `off`; see the settings-file exception for where it
lives), and `shouldPoll` is a token plus at least one connected repo that is either not `off` or still owed its cold-boot sync. That one sync is the exception
`off` carries: a never-filled cache would leave an `off` repo's columns empty behind `connecting…` forever, a worse lie than a stale age, so the first sweep of a
process fills it once and every later one skips it. A machine whose every repo is `off` therefore disarms after those syncs, and `POST /api/trackers/sync`
calls `arm()` so that turning one back on restarts the chain. The tick stays `TRACKER_POLL_MS`, and all four intervals are multiples of it, so the tick is the
resolution and there is no timer per repo: a `15s` repo is due on EVERY tick with no clock check — which is why no existing tick-count assertion moved — and a
slower one once its interval has elapsed since its last sync, stamped on failure as well as success so a failing repo is not retried faster than it asked.

## A repo whose sync is off refuses every write path, and cannot be switched off under a live or paused run

#17, [spec](../superpowers/specs/2026-09-22-tracker-sync-interval-design.md) §6 and §8. An `off` repo's cache is not refreshed, so everything this server
knows about its issues and claims is as old as the last sync — and every write path decides something from that cache: whether a claim is held, what the body
was, which label to remove. A write against a frozen view is the same class of failure bug-55's phantom claim was, reached on purpose instead of by accident.
So `off` refuses them all, with one sentence naming the repo and the fix — `sync is off for <owner/name> — turn it on in GitHub › Settings` —
composed in exactly one server place (`TrackerPollerService.syncOffBlock`) and pinned byte for byte against the client's copy (`syncOffReason`), since the
client cannot import the server's composer.

The ten `/api/items/*` writes refuse inside the per-item serialisation and before any request to GitHub; `dispatch`, `orchestrate` and `resume` refuse
before any spawn; `abort` refuses before its dashboard stop, since a stop followed by a refused release would kill a session and leave its claim live; `plan()` names the same sentence as its block, so the launch sheet never offers what dispatch would refuse; and the board disables — never
hides — the dispatch control and the Orchestrate chip, because it is a per-project block rather than an environment one. Resume is on the list as belt and
braces for the route's own 409: a hand-edited file can still turn a repo off under a paused run.

**Why the switch itself refuses `off` under a run.** A run's driver claims, heartbeats, releases and labels through these very routes, so turning its repo off
mid-drain would park the run at its next write, and under a PAUSED run it would park the resume. `POST /api/trackers/sync` therefore answers 409 for `off`
while any registered project on that repo has a run file reading `running` or `paused`, or a starting entry. Any other interval during a run is allowed:
slowing a live run's sync costs latency, and that is the user's call. The route lives in `OrchestratorModule` for that check alone — it needs the run files and
the starting entries, and hosting it in `TrackerModule` would be a module cycle. Remote runs are the read-side twin: an `off` repo derives none, because a
frozen comment cache would otherwise show another machine's run as live for as long as sync stays off.

## The tracker and Jira caches are the two caches in this server whose age is a rendered value

`TrackerPollerService` holds every connected repo's issues in memory, per repo, lost on restart and rebuilt by the first sync (task-45, spec §5.1). Every other
read in this server is per request and uncached — the registry, each project's source marker, the run files, `uncommitted` — and those rules are untouched: this
poller re-reads all of them on every tick. What it keeps is the one thing behind a network call with an hourly budget.
The Jira board cache is the second (`JiraPollerService`, one list per board, `polledAt` per board in `GET /api/jira`), allowed for the same reason and kept
honest the same way; everything below is about the tracker's.

The cache is allowed to exist because a per-request fetch is impossible: one board render would be one GitHub request per project, and a person watching the
board would exhaust 5,000 requests an hour in minutes. It is kept honest by being VISIBLE — `polledAt` travels in `ProjectSummary`, the shell's tracker chip
counts the sweep down on its POLL meter (#228 — the board's band printed `futin/x · polled 12 s ago` before that), the item modal prints it beside the body it drew from that same cache, and the Sources card prints it per repo. A cache
whose staleness is on screen is a different object from one that is not.

**The orchestrator's queue preview is the fourth reader of that age, and a named id gets one retry before it is refused (bug-41).** `trackerCandidates`
(`skills/backlog-orchestrate/tools/orchestrate.mjs`) builds a tracker run's whole queue from one `GET /api/items`, which for a tracker project is this cache —
so an issue GitHub accepted after the last tick is absent from it for up to one poll interval. That produced two failures, and the second was the worse one: a
`--ids <n>` naming such an issue read as `unknown item id: <n>`, which sounds permanent for a case that clears itself in seconds, and a whole-queue run simply
left the newest issue out with no message at all. Both are now the age being said out loud. The `--ids` miss sleeps until the next tick is due
(`trackerRetryDelayMs`, timed off this project's `polledAt` from `GET /api/trackers`, clamped to one window and to zero for a stamp already overdue — a
disarmed poller will not answer a longer wait either), re-reads the index ONCE, and refuses only on a second miss, with the age in the sentence; the
whole-queue branch prints `queue built from the tracker cache (polled 12 s ago) …` on stderr, at `plan` and `init` alike, because that branch has no refusal
to improve and the age IS the fix there. A files project reaches none of it — the files branch of `buildGatedQueue` never enters this function.

What was rejected, and why it stays rejected: giving the READ path `GithubSource.issueNow`'s per-id fresh `GET` (plus a route for the CLI to reach it) would
close the window exactly rather than wait it out, at the price of a second read path into the adapter and a new way for a preview to spend rate limit — to
save at most fifteen seconds. `GET /api/items/claim` exists because a CLAIM cannot tolerate being one poll stale; an item's EXISTENCE plainly can. If a case
ever appears where the wait is not tolerable, that is the design to revisit.

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

**Neither read asks from its mark itself — both ask from five minutes behind it (`SINCE_OVERLAP_MS`, `sinceFor`).** A separate mark per stream fixed the
clocks, but not the fact that each stream's listing is eventually consistent. On 2026-09-29 another machine's groom promoted brickwright#22 into #28 and
closed #22 eighteen seconds later; one poll here got #22's close and #27 but not #28 yet, the mark moved to #22's stamp, and every later `since` excluded #28 —
the board lacked it for hours while #27 and #29 on either side of it showed, and only a restart's full read would have brought it back. `absorbIssue` moves
the mark the same way, past anything the poll has not caught up with. The overlap re-reads a few minutes per tick at no cost the cache notices (it upserts by
number and by id), and because the request is a function of the mark alone, never of the clock, a quiet repo re-sends the same URL and its ETag still earns a
`304`. The mark itself stays the newest stamp seen; only the request moves back.

**A deletion is invisible to that stream, so every claimed issue is reconciled on its own (bug-55).** `since` returns what was created or edited, and a
deleted comment is neither, so no repo-wide response can ever say one is gone. `forgetComment` covered the one deletion the protocol makes — a loser removing
its own claim — but only on the machine that made it: on 2026-09-22 two machines raced for one issue twice, the protocol picked the right winner both times, and
both times the loser's deleted claim stayed in the WINNER's cache as a `running`, `fresh` remote run, an `executing` card and the answer `GET /api/items/claim`
gave, until the process restarted. Each tick now re-reads the comments of every issue the cache holds an unreleased claim on — conditionally, so a quiet held
issue is a budget-free `304`, and not at all when nothing is held — and a cached comment on that issue the list does not carry is dropped, unless it is younger
than `RECONCILE_GRACE_MS`, because the listing is eventually consistent and a claim absorbed a second ago may not be in it yet. Fixing the one bag all three
readers share was chosen over each reader filtering: "ignore a claim with a lower live rival" draws the ghost as the holder again the moment the winner
releases, since it is then the lowest unreleased claim. A periodic full resync was rejected too — a ghost would live a whole resync period, at a cost that
scales with the repo's comment count rather than with what is held.

That is also why `readClaim` does not trust a cache MISS. A miss means "this process has not seen it", never "nobody holds it" — a server that started after
the claim, or a second machine's server, has every right to one — so it falls back to a single fresh per-issue read. The cache stays the fast path and the
common one; the fallback is what makes the answer safe to act on.

**The comments request is made on every tick, and since task-46 it has a reader.** One conditional request covers every comment in the repo, including edits,
which is what makes per-item claim watching cheap. Phase 2 made the call with nothing reading it, deliberately, so that the polling loop's shape, its budget and
its tests would not move in the phase that also introduced the protocol they feed — and that bet paid: task-46 added `TrackerPollerService.comments()` over the
same cache and changed nothing about the loop. `test/tracker-poll.test.ts` asserted the call explicitly while it had no reader, precisely because a call with no
reader is what a later edit deletes as dead. Task-48 gave `comments()` its second reader, `RemoteRunsService`, which derives other machines' runs from the same
cached comments on every `GET /api/orchestrator/runs` and keeps no cache of its own — this stays the one tracker cache.

**Rate limits are a state, not an exception.** Nothing in `github.client.ts` throws on an HTTP status: every response — including a transport failure, which
surfaces as `status: 0` — comes back as a value the poller turns into `access` and `detail`, because every one of them is something the board renders rather
than something a request handler should make a 500 out of. A `403`/`429` with `remaining: 0` or a `Retry-After` puts that repo to sleep until the reset and
records the reset TIME (not a duration, which goes stale the moment it is drawn); a secondary limit backs off sixty seconds. While asleep the repo gets no
request at all, not even a conditional one: a `304` is free against the budget but a `403` is not, and asking again before the reset is how an app earns a
secondary limit on top of the one it has.

**The label set has one home and one cross-file guard.** `server/src/tracker/labels.ts` lists the eleven labels — spec §5.2's eight, `orchestrator:queued` (task-52), `in-review` (execute `pr` mode) and `plan-review` (backlog-tick) — and the poller creates whichever
are missing on the first successful sync of a repo — idempotently, case-insensitively (GitHub label names preserve case but collide without it), treating a 422
as success because another machine's poller winning the race still leaves the label there. This is phase 2's ONE write to GitHub, and it is a bootstrap rather
than a lifecycle write: the issue→item mapping cannot work without the set. `skills/backlog/tools/backlog.mjs`'s `connect` writes issue forms that pre-apply the
four `type:*` labels and CANNOT import that module — a skill's `tools/` is a standalone copy of what was pushed — so the agreement is enforced the other way
round: `test/tracker-labels.test.ts` reads the skill's source as text and asserts the two lists match. A comment asking two files to stay in step is what drifts.

## `jira.json` has exactly one writer, and a file that cannot be read is never replaced

The Jira integration ([spec](../superpowers/specs/2026-10-15-jira-integration-design.md) §2) keeps its boards, saved queries, repository map and skill
prompts in `~/.backlog-manager/settings/jira.json` — the fourth file under `settings/`, and the first one a person is expected to edit by hand as well as
through the server. It takes `tracker-sync.json`'s posture (the settings-file exception above): read fresh on every use, cached nowhere, one writer — the
server, through six routes, `POST /api/jira/boards`, `/boards/delete`, `/repos`, `/repo-defaults`, `/skills` and `/skills/delete` — and a person's hand-edits,
which the writers are built to survive.

**An unreadable file is reported, never treated as empty.** `readJiraConfig` answers `unreadable` for a file that exists but cannot be read or parsed, and
`GET /api/jira` carries it as `configUnreadable`. The failure this prevents is the one #270 found in `tracker-sync.json`'s writer, one step earlier: a
board that renders `No boards yet` over a file with a stray comma invites the person to create a board, and the write that follows — reading the file as `{}`
and writing one board back — would erase every board, query and mapping the file held. So the reader says the file is broken, the sweep prunes no board
cache while it is (a board the file still holds keeps its list until the file parses again), and all six writers refuse with a 409 rather than replace it.
A MISSING file is a fresh install and reads as empty; so does a file that parses to something other than an object, which is what `tracker-sync.json`'s
writer already replaces and so what the six writers agree with.

**Six writers, one contract, and the refusal is each writer's own.** `writeBoard`, `deleteBoard`, `writeRepos`, `writeRepoDefaults`, `writeSkill` and
`deleteSkill` each read the RAW file, not what the reader
would accept, because a writer that round-tripped through the reader would silently drop every entry the reader warned about — the same erasure #270 found,
by a quieter road. They merge exactly one entry (a board by id, one project's list by key, one path's defaults by path, a skill by id) and leave the rest
untouched, hand-written junk and unknown
top-level keys included, so a person's annotation or a newer version's key survives a save made by an older one. The write is a temp file in the same
directory and a `rename`, so a crash leaves the old file or the new one and never half of either. The refusal is the writer's rather than a check the route
makes first because the route's read and the writer's read would be two reads: a file that broke between them would be replaced after the check passed. So
`JiraConfigUnreadableError` comes out of the one read the write is built on, and the route's only job is to map it to a 409 with the message — which tells
the person to fix or delete the file by hand and that nothing was written, the one sentence the board sheet shows under its footer with every edit intact.

**Config writes do not wait on Jira.** They are open under `access: unauthorized` and `unsupported`: they touch only `jira.json`, and a person whose token
expired is exactly the one who needs to be able to correct a board. The sweep a save triggers is the poller's, bounded and a no-op where it cannot run,
so the route answers 200 with the board either way.

**The fallback is per entry, because the data is hand-written.** One bad value costs its own entry: a board with a mistyped id, a root that is not an issue
key, a query with an empty label, a repos path that is not a string. Spec §2 drew the line at the board; the reader goes one level finer — a bad root or
query costs itself, not the board it sits in — because a board that vanishes over one lower-case key is the more surprising failure. Every drop is warned
once, naming the file and the entry, so a vanished entry leaves a trace in the server log. The mechanism is `server/src/jira/config.util.ts`.

**`repoDefaults` joined under the same contract** (Jira repo/branch, spec §5.1, §6). It maps a mapped path — absolute, normalised — to the base a New worktree
is cut from and the pattern its branch is named by, and it is keyed by PATH rather than by project because one checkout can be mapped to two Jira projects and
has one convention. Its writer is the sixth, `writeRepoDefaults`, behind `POST /api/jira/repo-defaults`: the same raw read, the same one-entry merge, the same
temp file and `rename`, the same 409 for an unreadable file; both values unset deletes the path's entry. The route adds one check the other five do not need —
the path must be mapped by SOME project, a 400 otherwise — so the file does not collect defaults for paths nothing can reach, and it sits after the 409
because an unreadable file cannot say what is mapped. Its reader's fallback goes one level finer again, to the VALUE: a base that fails `branchNameProblem` or
a pattern that fails `patternProblem` — the same checks the route applies — costs only itself, so a hand-edited bad pattern leaves that path's good base
working.

## The Jira token never leaves the server, and the poller is armed only while a board syncs

The GitHub token's rule (above), stated again for a second credential rather than assumed to cover it: this app now holds secrets for two services, and a rule
written about `BM_GITHUB_TOKEN` is not the one a reader of `server/src/jira/` will look for. `BM_JIRA_SITE`, `BM_JIRA_EMAIL` and `BM_JIRA_TOKEN` are read by
`jiraEnv()` per call and never cached; no route returns the email or the token, no payload carries them, and the browser never talks to Atlassian — every call
is board → `/api/jira` → Jira. `GET /api/jira` says `site`, `me.name`, `me.accountId` and `tokenKind`, which is what the Connection card needs to show the
right account is in place and nothing more.

**One header, one host, one place.** `JiraClient.request` builds the `authorization` header and every call passes through it, which is what makes "the token
is in no URL and no message" a property of one function rather than of every call site. Every call goes to the API gateway, a constant, because that is the one
address a scoped token can reach (spec §14 P14) — so nothing in a request names a host. The two site-URL calls are deliberate: `tenant_info` carries no
credential at all, and the `myself` probe that tells a classic token from a scoped one is sent once, after the gateway has already accepted the credential.
Project listing pages by `startAt` rather than following the `nextPage` URL Jira returns, so Basic auth is never sent to an address a response body chose.

**Armed only while there is something to do.** The poller is the GitHub poller's `setTimeout` chain, and it arms on the same "still owed" logic: a board that
polls, a board owed its one cold sweep, or a boot answer still missing. An unconfigured install, or one whose every board is `off` and already swept, makes no
call to Atlassian at all — and `unsupported` (a Server/DC site) disarms for good, because no retry will make it Cloud. Compose passes the three keys as
interpolations with empty defaults, never literals — bug-25's rule, where a literal is an account committed to a public repository.

**`jira.mjs` goes through the server too, though it could call Jira itself** (Jira phase 4, spec §10). A CLI with the three variables in its environment
could reach the gateway directly, and it deliberately does not: the server is Jira's ONE caller on this machine, so there is one rate-limit budget, one 429
window and one identity, and a second caller would spend the first, miss the second and could disagree about the third. The other reason is where the CLI
runs — inside a session in a mapped repository, reading a ticket whose text anyone with Jira access wrote. A token in that session's environment is a token a
ticket's description could ask the session to print; a token that only the server process holds is not. So `jira.mjs` dials `127.0.0.1` and nothing else,
reads no `BM_JIRA_*` and builds no `authorization` header, and its source guard fails on any of the three.

## Jira's Done column is a window, not a store

A board's roots are walked to their descendants, and a long-lived epic accumulates done children for as long as it lives. Kept, they would bury the open work
under a Done column that only grows; the board is "what is live", and a query author who wants history has JQL for it. So a `done` issue whose resolution —
or, when Jira recorded none (a workflow that moves into a done status without setting one), whose last update — is more than `JIRA_DONE_WINDOW_DAYS` (14)
old is dropped as it is mapped (spec §3).

**At map time, and in one file.** `mapJiraIssue` applies it, so the cache, the board payload and the client never see an expired issue and none of them holds
a second copy of the 14. Dropping before the caps means an expired issue never takes a place a live one needed. The window is for the `done` category alone:
an issue reopened after an earlier close still carries that stale `resolutiondate`, and dropping it would hide exactly the work that came back.

**The walk still sees what the window dropped.** The next `parent in` round names every key Jira returned, mapped or not, so a closed story's open subtask
stays on the board. And the window is the SWEEP's: the issue detail, its children and the roots search pass `now: null`, because a person who opens or
searches for a specific issue must get it however old it is — a picker that could not find last month's closed epic would read as "Jira does not know it".

## Every value the server puts into JQL is quoted and escaped, and a person's JQL is passed verbatim

Two sources write JQL in this app, and they are trusted in opposite ways. The SERVER builds queries from values — a root key, the keys a walk round returned,
the text typed into the roots picker — and every one is a double-quoted string with `\` and `"` backslash-escaped (`jqlString`, `key = "PAY-1"`). A key is
also validated by `isJiraKey` before it gets there, but the quoting does not rely on it: the keys a walk interpolates come out of Jira's own response, and the
search term is free text by definition. Without the quoting, a search for `x" OR project = SECRET` would be a query the person did not write, run with the
server's credentials — and the escaping is what makes `"` and `\` searchable at all rather than a 400.

A PERSON's JQL — a board's saved query, the text in the board sheet's check line — is theirs to write, and the server never edits it: no added clause, no
rewritten order, no quoting. Jira parses it and Jira refuses it (`jql/parse?validation=strict` for the check, a 400 on a sweep that becomes a `failures` row
on the board, never a dropped board). Rewriting it would be guessing at what the person meant, and a filter that silently differs from the one typed is worse
than one Jira rejects out loud. The only bound is length (`JIRA_JQL_MAX_CHARS`, 2 000), because a query that long is a paste accident, not a filter.

## A Jira branch name obeys one rule, and `jira.mjs` carries its one hand-kept copy

A Jira Run names a branch — and, for a New one, a base — that the server pastes into the spawn prompt's `jira.mjs worktree` line (Jira repo/branch, spec §6).
Three hands judge those names: the launch sheet, before Start; the server, on `GET /api/jira/prompt` and `POST /api/agents/dispatch-jira`, whether or not the
repo is mounted; and the tool, in the session, before it runs any git. Two of them share code, so the rule is written once, in `shared/jira-branch.ts`, the
way `shared/agent.ts` holds what both sides of the board must agree on: `branchNameProblem` (Table A) says why a name cannot be a branch, and
`branchCarriesKey` (Table B) says whether a branch belongs to the ticket. The setup pattern is judged by the same two, through `patternProblem`, on the name
it would render — a pattern whose branches the board would never find again is refused at Setup, not at Start.

**Narrower than git, on purpose.** Table A is `git check-ref-format --branch`'s rules plus two of this app's own: at most 200 characters, and nothing outside
`[A-Za-z0-9._/-]`. Git accepts far more, but a name that reaches the prompt is a word in a shell command a session will run, and with that allowlist it
cannot carry a space, a quote, `$`, a backtick, `;` or a newline at all — so the server prints `branch` and `base` bare and does not lean on the session to
quote them. The repo path is the one value that can hold anything, and it alone goes through `shellQuote`. A name git would take and this refuses (`~`, `^`,
`:`, `@`, anything non-ASCII) costs a rename; a name that escaped the prompt would cost whatever it said.

**The third hand cannot import, so it copies.** A skill's `tools/` is a standalone copy of what was pushed, with no build step and no path back into this
repo (the reason `backlog.mjs` restates `resolveSource`), so `jira.mjs` re-implements Tables A and B and says so above each. The drift guard is the tests:
`skills/jira/tools/jira.test.mjs` pins the same rows `test/jira-branch.test.ts` does, so a rule changed in one place and not the other fails on the side left
behind. The tool's copy is not redundant with the server's check: the person can paste the prompt into a terminal and edit the line, and the tool is the
last thing between that line and `git worktree add`.

## The board's Jira writes are assign and transition, nothing else

Until phase 3 this server wrote to Jira nowhere: every call was a read and the only file it changed was `jira.json`. Phase 3 ([plan](../superpowers/plans/2026-10-19-jira-phase-3-writes.md),
spec §8, §13) adds the first two calls that change anything on Atlassian's side — **assign the issue to me** and **transition it** — and this rule is what keeps
the list at two. A third (comment, edit a field, create, unassign, assign someone else) is a new rule and a new section here, never another route that "fits
the pattern": a credential that can write to a person's tracker is the sharpest thing this server holds, and the size of what it may do with it should be a
fact a reader can check by counting routes (`POST /api/jira/issue/assign` and `/issue/transition`, in `jira-write.controller.ts`).

**`{ accountId: null }` is never sent.** Jira reads a null assignee as UNASSIGN, so an assign sent while the identity was unknown would not fail — it would
succeed at the opposite of what was asked. The poller therefore refuses an assign with no call when `me` is null (`503 no identity`, which heals on the next
successful `myself`), and the body's accountId is always the poller's own `me`: a request cannot name anyone else, and one that tries is ignored. While the
site's `access` is `unauthorized` the refusal comes first, even when `me` is still set from before the 401, because a credential Jira has just rejected is the
same 401 whatever else is known. A transition needs no identity, so it is refused only under `unauthorized` — `boot.reset()` leaves `cloudId` set, which means
the read gate alone would have let it through. Config writes stay open under `unauthorized`; issue writes do not, and that asymmetry is deliberate.

**The offered list is checked fresh, and its refusal is this server's own.** The modal draws its `Move to…` menu from a detail read that is minutes old by the
time someone picks, and a workflow can move an issue in between. So a transition begins with a fresh `GET issue/{key}/transitions` and checks the id against
it. Jira's own answer to a stale id is a 400 whose sentence is about Jira's ids, which reads as a failure of the board rather than of the pick; the route's
`400 transition not offered` says what happened. The id's own shape is not checked beyond a non-empty string of at most 64 characters — the offered list is
the real validation, and a guess at Jira's id format would one day refuse a valid one.

**A re-read, not a local patch.** After a landed write the poller reads the issue again and replaces its copy in the caches; it never edits the cached copy
to say "assignee: me" or "status: In Progress". Jira's workflow can run post-functions that change more than the field written — a transition that also
clears the assignee, sets a resolution or moves the sprint — and a local patch would draw the card as the person expected rather than as Jira now has it,
until the next sweep quietly corrected it. The re-read is also the one place the rest of the issue (`updated`, `resolved`) is learned, and `updated` is what
the newest-wins rule below compares.

**In place, never added.** The splice replaces the issue at the SAME index in every board cache that already holds the key, and adds it to none. Membership
of a board is its queries' and roots' business and nothing else's: a splice that added the key would let a write put an issue on a board whose JQL
excludes it, and the next sweep would then take it off again. A re-read that does not map to an issue — unreadable, or dropped by the Done window — leaves
every cache untouched. The mapping uses the sweep's own context, the window on, so a spliced copy is one the sweep itself could have produced.

**Newest `updated` wins, so a sweep cannot undo a splice.** A sweep in flight across the write read the issue before it, and Jira's search index can lag
the issue itself by a little: either way the sweep's copy is the OLDER one, and putting it back would move the card back until a later sweep moved it
forward again. At the end of each sweep, for every issue it returned whose key the cache now holds with a strictly newer `updated` (`Date.parse`), the cached
copy is kept; equal, or unparseable on either side, is the sweep's. The rule only ever replaces. A key the sweep did not return is gone as before, which has
one accepted consequence: a lagging index can drop a just-assigned issue from an `assignee = currentUser()` board for one sweep. That is named in
[jira.md](jira.md#the-issue-writes-phase-3) so nobody files it as a bug.

**`reread` is the write's footnote, never its verdict.** Both routes answer `200 { ok: true, reread }`. The write landed, and that is what the 200 says;
`reread` says whether the re-read afterwards came back as an issue, true even when the Done window then dropped it and false when the 2xx body was not an
issue or the call failed. A failed re-read after a landed write is still a 200, because an error would invite a retry of something that already stood. The
re-read's own failure still goes through the same bookkeeping as any read, so a 401 or a 429 there moves the site state.

**No per-key queue.** The tracker's item writes are serialised per item because they are read-modify-write on a body: two interleaved writes lose one. These
are not — each sends one field's new value and Jira orders them — so two browsers racing are Jira's last-write-wins and the newest-`updated` rule keeps the
caches on whichever answer is newest. The one-at-a-time guard is the modal's, through the `useAction` hook, which also stops a double click; it is a courtesy
to the person, not a lock the server relies on.

**`dispatch-jira` is a second caller of the two writes, never a third write.** Phase 5's Start may assign the issue to me and move it before it spawns, and it
does so through `JiraPollerService.assignToMe` and `transitionIssue` — the same two methods, the same refusals and the same mapping (`jiraWriteOrThrow`, hoisted
to `unwrap.util.ts` so the three callers cannot word a failure differently) — so counting the poller's write methods still gives two. What the dispatch adds
is order and bookkeeping, not capability: everything it can refuse is refused before the first write (the transition is checked against a fresh read of what
the workflow offers, `no identity` before an assign is attempted, the first composition's length), an assign the ticket already carries is skipped rather
than sent, and a failure after a landed write says so in its own sentence (`— the assign stands`, `— the Jira writes stand`) because the write is not
undone and a retry must not be invited as though it were. Unassign, assigning anyone else, a comment and a field edit remain a new rule apiece.

## A Jira session is remembered in server memory only, and Stop is the one hand that clears it early

Phase 5's Run starts a Claude session for a Jira ticket, and the board has to show which tickets have one going and refuse a second. This server keeps that
fact in memory and nowhere else: `JiraLiveService` (`server/src/jira/live.service.ts` — the spec calls it `JiraService`; the plan ruled otherwise, so `jira/`
has one service named for what it holds) is a `Map` with no I/O, and a restart forgets it. A session is a fact about a process on this machine, and the dashboard,
not this server, is the place that knows whether it still runs; a persisted entry would outlive the process that knew, and would need a second mechanism to
decide which claims to believe. The accepted cost is that after a restart a card shows no strip for a session that is still running, and a second Start on
that key is then possible; `DispatchRecordsService` makes the same trade for the same reason.

**The order protects the one-session-per-ticket rule, and so does what the map refuses to evict.** The key is reserved (`sessionId: null`, `starting`)
BEFORE the dispatch's first Jira write, by a synchronous check-and-set: of two Starts that both cleared the dashboard gate exactly one passes, because
nothing can run between the check and the set. Reserving after the writes would let two requests each assign and transition the ticket before one found out it
had lost. Every failure after the reservation releases it through one `catch`, so no failure class — a Jira error, a refused composition, a spawn that fails —
leaves a key `starting` until the 8-hour expiry; a retry after any of them is a fresh Start, not a 409. `release` touches a `starting` entry and nothing else,
so a late failure path can never drop a session that did start, and a Start whose own `reserve` was refused releases nothing, because the entry in the map is
the OTHER request's. At the cap of 100 the oldest CONFIRMED entry is evicted, and a `starting` one never is: its spawn is in flight and will confirm or
release it, and evicting it would let a second dispatch pass the gate while the first is still launching. When every slot is starting, `reserve` refuses and
the caller says the map is busy. The 8-hour expiry is strict and lazy — read at the top of every call, no timer — and is the backstop for a session nobody
stopped and the reconciler could not judge.

**Stop is the one deliberate hand, and the reconciler only agrees with the dashboard.** `POST /api/agents/jira-stop` asks the dashboard to stop the session and
then forgets the key; it never calls Jira, because the ticket keeps its assignee and its status — what the confirm in the client says. A 200 and the
dashboard's `no live session` 404 both mean the process is gone, and both clear the entry; any other answer is a 502 and the entry STAYS, because the
session may still be running and a strip that said otherwise would invite a second Start on a busy repository. (The 404 that carries `remote answers
disabled` is not "gone" — it says nothing about the session.) A session can also end without a Stop — it finished, it crashed, someone stopped it from the
dashboard — and then the key would show a strip until the expiry. `JiraLiveReconciler` (`server/src/agents/jira-live.service.ts`) is what notices, and it
lives in `agents/` because it calls the dashboard and `jira/` imports nothing from there; the dependency runs agents → jira and never back, which is also why the
map is free of timers. It follows the run watchdog's shape: a `setTimeout` chain armed by `confirm`, pending only while some entry holds a session id,
`unref`'d, never awaited by a request, and swallowing what it catches because it runs from a timer with nothing above it. One `GET /api/sessions` per tick
(60 s); an entry stays only while its session is `working` or `question`, because the dashboard keeps an exited session as `idle` for its whole lookback, so
"present" proves nothing and only "not busy" reads as ended. An entry younger than two minutes is never judged — a just-spawned session has no transcript, so
the list does not carry it, and absent then means "not yet". A `starting` entry is never judged (its own Start settles it), a list that cannot be read leaves
the map exactly as it was (an unreadable answer is not an answer), and a verdict clears an entry only if it still holds the session id it was judged for,
since the list was read across an await in which a Stop and a fresh Start can have replaced it.

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

That block stopped being source-blind in #227, and the asymmetry is deliberate. A tracker claim has a heartbeat and a holder, a files stamp has neither, so only
the tracker claim can be aged: `progressBlock` lets dispatch through over a STALE hand claim, because the protocol already lets any `start` retire it with no
confirm and the spawned session's own `start` does exactly that, while a files stamp still blocks on ANY stamp, fresh or stale. Two stale tracker holders keep
the block — a run (a stale run claim is a crashed run, the watchdog's and `--resume`'s) and a session this server dispatched (a `claude -p` waiting on a reply
sends no heartbeat, so its age says nothing). And the server now re-checks a tracker item's claim at dispatch (`itemClaimBlock`, `agents.service.ts`, in
`progressBlock`'s order, a stale claim going through `staleClaimProbe`), because the sheet's plan was read once and the claim moves under it; a files item is
not re-checked there, since its stamp has no heartbeat to age and no holder to name, and refusing it is `start`'s job.

The ORCHESTRATOR followed one phase later, and the two-phase shape is worth keeping on the record. Task-46 could not lift it with dispatch, so it gave the
refusal a gate of its own on each side: `projectIsFiles` (`client/src/lib/tracker.ts`) hid the toolbar control, and `AgentsService.orchestrate` answered 400
`orchestrating a tracker project arrives in phase 4` before `resolveIds` — necessary then because `resolveIds` scanned FILES and would otherwise have found
none of a tracker project's ids and 409ed each one as "not an open bug or task in this project", which is both wrong and unactionable.

**Task-47 (phase 4a) removed both, and what replaced them is `resolveIds` learning the vocabulary rather than a looser gate.** `projectIsFiles` is deleted (it
had exactly one job and its own doc comment said so), the 400 is gone, and `AgentsService.resolveTrackerIds` now proves a tracker project's ids against
`ItemsService` where the files path proves them against a directory scan. It accepts all three spellings a caller can hold — `#31`, this project's own URN, and
the bare `31` (until #270 the URN's `owner/repo` was read past, so another repo's `#31` became this one's; now it is a 400 with `backlog.mjs`'s
sentence, compared case-insensitively as GitHub compares) — and **emits exactly one: bare digits, before the prompt is composed.** See "the orchestrate and Jira spawn prompts are composed server-side" and
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

## The eleven item-write routes are guarded, refused for `files`, and serialised per item

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
nothing else, and the one check that reads the field is what makes that true for all eleven routes at once instead of eleven routes each remembering to ask.

**Every refusal is a value.** `ItemWriter` answers `WriteOutcome`, never throws, and `GithubClient` beneath it answers a `GithubResponse` for every status —
the same posture, one layer down. `answer` (`write-answer.util.ts` since #270, when the claim READ route
started sharing it instead of answering 502 for everything but a miss) is the only place a `refused` becomes a status: `no-token` 503, `not-found` 404, `conflict` 409,
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
`state` is still taken outright. It rides the heartbeat route rather than a new write route, because a route for one field would have moved the headline's
count for nothing; the count did move later, for `queue` below, which is a whole write of its own.

**The eighth write route is `queue` (task-52, [the orchestrator:queued spec](../superpowers/specs/2026-09-23-orchestrator-queued-label-design.md) §2).**
`POST /api/items/queue`, body `{ project, id, queued }`, adds or removes the advisory `orchestrator:queued` label, and it is everything the seven are: the
same class decorator, the same `writerFor` gate (so a `files` project is refused before any network call), the same per-URN chain, so a queue write and a claim
on one item never interleave. `queued` must be a literal boolean — a truthy string silently choosing "add" is the mistake the 400 exists to name. Its one rule of
its own: a REMOVAL's 404 is success. Every `queued: false` caller is a sweep, whose contract is "the label is not there", and a label already gone — most often
because a human's won claim swapped it off first — is that contract met, not a failure worth a warning line. The driver reaches GitHub through this route and
no other way; the headless session never holds the token.

**The ninth write route is `abort` (#225), and it is the one outside `items/`.** `POST /api/items/abort`, body `{ project, id }`, releases a live claim
whose session was stopped from the dashboard, or died, without running its own closing `stop` — before it, a board-dispatched groom or execute left its item
reading as in progress on every machine until the heartbeat went stale. It lives in `agents/items-abort.controller.ts` because it calls the dashboard, and
`agents/`, `tracker/` and — since the Jira integration — `jira/` are the only outbound-calling modules; it gates and maps through the same exported
`writable` and `answer`, carries the same class
guard, and its release goes through `ItemWriter.release` on the same per-URN chain. Two proofs, one per case: a session THIS server dispatched (an in-memory
`DispatchRecordsService` entry — lost on restart on purpose, like a starting run) is stopped through the dashboard first, and only a 200 or the `no live
session` 404 lets the release through; any other session needs the claim's `host` to equal this server's `BM_MACHINE_NAME` and the dashboard's session list to
report it neither `working` nor `question` — absent from the list is refused, because not found is not the same as not running. A run-held claim, live or
stale, and a released one are refused before the dashboard is asked anything. The release carries `authority: 'board'`, the release rule's fifth clause, which
the `release` route never parses — so no HTTP body can reach it, and the one caller that sets it has already made one of those two proofs.

**A STALE claim is the abort route's third case (#227), and its default is the opposite of case B's.** Before it, a claim past `CLAIM_STALE_MS` was refused as
`not claimed` on the reasoning that the protocol retires it at the next `start` — while the board went on showing it held and offered no way to let go of it.
A stale claim is forfeit by protocol: any `start`, on any machine, retires it with no confirm, so the board doing the same behind a confirm adds no authority.
A holder this server dispatched still goes through case A, because its heartbeat age says nothing. Any other goes through `staleClaimProbe`
(`agents.service.ts`), which refuses only on a POSITIVE answer — the claim's `host` is this machine's and the dashboard reports the holder `working` or
`question`, a late heartbeat rather than a dead session — and proceeds on every unknown, agents off included: case B releases a LIVE claim, so every unknown
there must refuse; here the claim is already forfeit and the probe is only a guard. The release is `reason: 'stale'`, `by: 'board'`, with no `authority`
(`release` refuses only a live claim held by somebody else), and it unassigns the issue like `aborted` does, since nothing replaces the assignee after it. The
dispatch route re-checks the same claim for a tracker item and shares the probe: a run's claim, the board's own session's, or a live one is a 409; a stale one
proceeds unless the probe refuses.

**The tenth write route is `review` (the execute pr-mode spec, decision 9), and it is `queue`'s twin.** `POST /api/items/review`, body
`{ project, id, inReview }`, adds or removes the `in-review` label — the tenth tracker label — with everything `queue` has: the class guard, the `writerFor`
gate, the per-URN chain, a literal boolean or a 400, and a removal's 404 answered as success. The label exists because `pr` mode leaves a tracker issue OPEN
and UNCLAIMED once its branch is pushed: the claim is released after the push, and the issue closes only when the PR merges and `Closes #<n>` shuts it. In that
window every gate would read the item as ready and start a second execution of work already waiting on a reviewer. Execute runs `backlog.mjs review <id> on`
right after a successful push, PR or not; a person runs `review <id> off` when the PR closes unmerged. Every per-item gate reads the mapped `inReview` flag
through one sentence, `a PR is open for this item` (`IN_REVIEW_REASON`, `shared/agent.ts`, with hand-kept copies in `orchestrate.mjs` and execute's skill
text): the board's Run button, the server's `plan`/`dispatch` ladder (an uncoded 409) and the orchestrator gate, which turns the item `ungroomed` with that
reason so no new verdict reaches the run's stages. A files project has no label to carry, so `review` is tracker-only and a files item's PR guard is a named
known limitation, not a gap this route papers over.

**The eleventh write route is `plan-review` (backlog-tick), and it is `review`'s twin.** `POST /api/items/plan-review`, body `{ project, id, planReview }`, adds
or removes the `plan-review` label — the eleventh tracker label — with the class guard, the `writerFor` gate, the per-URN chain, a literal boolean or a 400, and
a removal's 404 answered as success. The label exists because a tick's groom writes a plan nobody has read, and to every other gate a groomed item reads ready:
without a mark the board's Run, the server's `plan`/`dispatch` and the orchestrator's queue would each execute it. A literal boolean for `review`'s reason, with
a sharper edge: coercing `'false'` to truthy would add the hold somebody was trying to lift, and coercing `'true'` the other way would leave an unreviewed plan
looking approved. `create` and `body` carry the same mark as an optional `planReview` (`runnerFix`'s twin, the 400 included), because `plan-review` has to land
in the same write as the plan, never after it. In `body` an ADD is a label call on the same chain after the `ifUpdatedAt` check and BEFORE the patch — and
unlike `runner-fix`'s, CHECKED: a failed add is a refusal with nothing written, so no groomed-but-unmarked plan is ever left behind, and a patch that fails
after a landed add leaves the hold on the old body, the safe direction. The patch's own response then carries the label and is what the cache absorbs, which a
tick needs because it reads the item back at once. A REMOVAL stays after the patch, is checked the same way (a 404 is success), and is followed by a re-read,
because neither label endpoint answers the issue. Not `labels` in the PATCH: that replaces the set and would race a claim's `in-progress` and the driver's
`orchestrator:queued`. This route only moves the label, so it has no order to keep; it re-reads after a landed change too.
The body route ADDs it with `true` and removes it with `false`, but only as part of a plan write; approval on its own is this route with `false`, said once, in
one place (`backlog.mjs plan-review <id> on|off`). Every per-item gate reads the mapped `planReview` flag through one sentence, `this plan awaits review` (`PLAN_REVIEW_REASON`,
`shared/agent.ts`, with a hand-kept copy in `orchestrate.mjs`), always after `inReview`'s. A files project carries the mark as a `plan-review: true` frontmatter
line instead, so this route, like `review`, is tracker-only.

**Beside the eleven there is one route that is a read.** `GET /api/items/claim` answers who holds one item, out of the cache, with no network call — unguarded, like
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
a third claimant arriving mid-race would change the answer for everyone who had already decided. The read route (`GET /api/items/claim`, `currentClaim`)
resolves the holder by the same lowest-live-id rule, falling back to the newest claim only when nothing is live — before bug-58 it answered the newest claim
outright, which inside a race window named the loser as the holder to `stop`, `heartbeat`, `abort` and `show`.

**The sequence is list · post · settle · list · UNION, and the union is what decides.** GitHub's comment listing is eventually consistent by a fraction of a
second, so a concurrent claimant can be absent from one list and present in the other; taking the second list alone would let both racers believe they won.
`settleMs` is one second in production and is set to `0` by the suites, whose cases are about which comments are in the union rather than about waiting.

The plan for task-46 wrote the first listing as happening AFTER the post. It is done before, and the difference is the counters: a seed read from a list made
after our own post would have to come from the cache (up to a poll interval stale) or force a second edit of the comment just written. Listing first costs
nothing — two listings either way — and the union still spans both, so the race semantics are untouched.

**The machine a claim names is a name the machine's owner chose, when there is one.** `hostIdentity()` defaults to `<user>@<host>`, which is what bug-46
needed: the one identifier a reader on another box can act on. On a PUBLIC repository that same string is published to everybody, and it spells out the OS
username and the machine's real hostname — on the laptop this was noticed on, a router-assigned UUID that tells a person nothing and a stranger something.
`BM_MACHINE_NAME` replaces it, blank reading as unset so the default survives an empty setting rather than putting a claim on the board held by the empty
string.

Hashing was the obvious alternative and is the wrong one. Only `session` and `host` are compared by equality, so those two COULD be digests and arbitration
would still converge — but `heartbeat` and `at` are arithmetic (`isLive`) and `counters` are summed, so a hash cannot touch the rest of the record, and
digesting the host destroys exactly the readability the field was added for. A bare digest of `user@host` is brute-forced in seconds (the input space is a
handful of names), so hiding anything real would need an HMAC with a secret every machine shares — key distribution for a lock whose whole virtue is that it
needs no shared infrastructure. A chosen nickname discloses only what its owner picked and stays a word the next person can read.

Read from the environment and nowhere else, as `BM_API_PORT` is, and read in BOTH tools. That second half is not symmetry for its own sake: `backlog.mjs` and
`orchestrate.mjs` both write claims on one machine, and the server's `sameHost` clause compares the two strings raw, so a machine that published the nickname
from one tool and the hostname from the other could not release its own driver's claim by hand.

**An aborted release clears the assignee; every other reason keeps it.** Winning a claim SETS the assignee, so it does double duty: a courtesy to a person
scanning the issue list, and — unavoidably — a second in-progress signal beside the label. After `stopped`, `merged` or `imported` the first reading is the
true one and the field stays, because it is the only record of who did the work that is visible without opening the issue. After `aborted` neither reading
holds: the session was torn down mid-item, so it records no work, and what a reader sees is an issue owned by a machine that is gone. That is the same false
signal `in-progress` is removed for, arriving through the other field the protocol writes, so it comes off with it — and nothing is lost, because the claim
comment keeps the whole history either way. Keying on the reason rather than on the release is what keeps the two cases apart, and `aborted` is a word both
`abort` commands already write.

**A loser DELETES its own comment; a stale claim is RELEASED, never deleted.** That distinction is the whole reason a claim is a comment rather than a flag. A
losing claim is litter this call chain created seconds ago and nobody has read. A stale claim is the permanent record of work somebody did, carrying the
counters to prove it — deleting one to tidy up a flag would erase the only evidence that the work happened. The retiring session writes
`released: { reason: 'stale', by: <itself> }`, so the record even says who retired it.

**Who may release: the holder always, the RUN that owns the claim, the HOST that holds the claim once it can show the session is gone, ANYONE once the claim is
dead.** The last clause is the same rule seen from the other side. A
dead claim is not somebody's property, and requiring the original session to come back and clear it would wedge an issue on the crash of a process that is
never returning.

The second clause is bug-42's, and it is not a second rule — it is task-47 §7.6's same-run takeover, which `claim` has enforced since phase 4a and `release`
never learned. `POST /api/agents/stop` records a stop and then spawns a FRESH `/backlog-orchestrate --abort` session; that session takes the run's driver lease
(`takeOverRun`, before it walks the queue) and then releases every claim the run still holds — as its own session, which under a holder-only rule is a stranger
to every one of them. So the force stop built for a driver that is dead or hung reinstated the exact state bug-40 removed: an unreleased claim, the
`in-progress` label, and `started`/`phase` on every machine's board. Going stale does not repair it — the mapper reads `started` off ANY unreleased claim, fresh
or stale. `ItemReleaseRequest.runId` is the assertion, a bare id rather than the whole `ClaimRun` (`claim` STORES that object; `release` only asks a question
about one already stored), parsed by `runIdOf` into a 400 on anything but a non-empty string, and sent by `trackerRelease` on EVERY release rather than only
abort's — a conditional would leave the resumed driver's terminal-stage releases, whose claim comments were posted by the session that crashed, quietly on the
refused path. `backlog.mjs stop` sends no `runId` and gains no authority.

**The same-run test is `typeof req.runId === 'string' && req.runId.length > 0 && existing.run?.runId === req.runId`, and the two guards are load-bearing.**
Written as the tempting `existing.run?.runId !== req.runId`, a request with no `runId` against a hand claim with no `run` compares `undefined !== undefined` →
`false`, the refusal disappears, and any session on the machine could rip a live `backlog.mjs start` out from under the person holding it. `claim`'s own
same-run filter guards the same shape with `typeof c.record.run?.runId === 'string'` and the two are meant to read alike. A claim with no `run` is therefore
never same-run with anything: a run has no standing to evict somebody working the item at a terminal. The dead-claim clause outranks the new one and is reached
first through `isLive`, so a stale claim carrying a foreign `runId` still releases to anybody.

**The third clause is bug-48's, and what it adds is a FACT, not a permission.** A hand-run session killed mid-item — the machine stopped, the terminal closed,
anything that is not a terminal stage — passes through no terminal stage either, so it releases nothing, and then every clause above answers about somebody who
no longer exists. The holder is gone. A hand claim carries no `run` by construction, deliberately, so a run can never evict a person at a terminal. And the
claim is LIVE, because `heartbeat` was re-stamped seconds before the kill — the fifteen minutes are not a grace period anybody chose for this case, they are
`CLAIM_STALE_MS` doing its ordinary job on a claim whose holder died between beats. The item then reads as in progress on every machine, its dispatch control
disabled everywhere, with no command anywhere to run: the only options were to wait out the window or delete the comment on GitHub by hand, which destroys the
record of the work and the counters that prove it. The orchestrator has exactly this path and it works — `orchestrate.mjs abort` releases with
`reason: 'aborted'` (bug-40) — and every word of that reasoning applies to a person. What a person did not have was something to assert: a run publishes a
`runId`, a durable name for the thing that is gone, checkable by a process that is not the dead one, while a hand session published only `session`, which
bug-46 shows cannot be resolved by anybody but the machine it was minted on. So the missing verb was blocked on the missing field, and bug-46 landing is what
made this executable.

**The assertion is the HOST, and it is split across two processes because only one of them holds the evidence.** The server's half is `sameHost` alone —
`ItemReleaseRequest.host`, validated by the same `optional()` that `claim`'s `host` uses, and compared under the same `typeof`/`length` guards as `runId` for
the identical reason: written as `existing.host !== req.host`, a request with no `host` against a pre-bug-46 claim with no `host` compares
`undefined !== undefined` → `false` and the refusal disappears for every old claim on the tracker. A claim with no `host` is never same-host with anything,
which is `ClaimRecord.host`'s own sentence that absence means "the machine was not recorded" and never "the reader's own". The other half — the proof that the
holding session is actually gone — belongs to `backlog.mjs abort <id>`, the only sender of that field, because the server can see neither the caller's
filesystem nor its process table. That is the same split billing already has, for the same reason: the CLI is the side holding the clock and the transcripts.

**`abort` refuses unless three things hold, and the order matters.** The claim's `host` must be non-empty and equal this machine's `hostIdentity()` — a
cross-machine claim is refused naming BOTH hosts, and a hostless one is refused rather than assumed local. The claim must be unreleased and live — a released
one has nothing to abort, and a dead one needs no abort at all, so that case exits `0` saying the next `start` retires it and makes no request. And
`holdingSessionEvidence` must answer `gone`: Claude Code's own process registry, `<configDir>/sessions/<pid>.json`, was read and understood and holds no entry
naming the holder whose process is still running (`kill(pid, 0)` succeeds or answers `EPERM`, and — where `/proc/<pid>/stat` is readable — its field 22 equals
the entry's `procStart`, so a reused pid does not pass). **That last check is meaningful only because the host check already ran**, and the asymmetry with
bug-46 is the whole point — on a machine that did not mint the session, an absent entry is bug-46's false negative and proves nothing at all. A session with no
`CLAUDE_CODE_SESSION_ID` has no registry entry and reads `gone`, which is correct: such a claim's `session` is `<user>@<host>`, a person at a terminal on this
host, and that person is the one running `abort`.

**The evidence was a transcript mtime until bug-49, and that could never fire for the case it was written for.** bug-48 called the holder alive if any transcript
of its session had an mtime at or after the claim's heartbeat. But the `start`/`heartbeat` that stamped the beat is itself a tool call inside the holding
session, and the session appends the call's `tool_result` AFTER the server stamps the beat — so every session killed after its last heartbeat returned has a
transcript newer than the beat, and `abort` refused all of them as "still writing here". The repro (`futin/guide-manager#5`, 2026-09-22) had to be cleared with a
raw `POST /api/items/release`; the unit tests stayed green because they set a transcript's mtime by hand and never modelled a session whose last act was the
beat itself. A transcript answers "did this session write after the beat", which every session did; the registry answers "is the process still there": a
graceful exit removes the file, and a hard kill leaves it behind with a pid that no longer answers.

**`holdingSessionEvidence` has three answers, and the third fails closed.** `unknown` when the registry directory is missing or unreadable, when any `*.json` in
it lacks a string `sessionId` or an integer `pid`, or — when the aborting process has a `CLAUDE_CODE_SESSION_ID` — when no running entry names the aborting
session ITSELF. That self-check is what catches a registry whose shape or location changed under a new Claude Code: a session that cannot find itself would read
every neighbour as gone too. `abort` refuses on `unknown` and says so ("cannot tell … wait out the 15 min window"), because a misread in that direction is the
one that turns a live neighbour into a dead one.

**`gone` means "no process now", not "stopped", and a board-dispatched session between turns is the case where those differ.** The dashboard runs every
dispatched session as `claude -p --session-id <id>` and every reply as a fresh `claude -p --resume <id>`, and a `-p` process exits normally when its turn ends —
removing its registry file. So a dispatched session that asked a question and is waiting on the answer still holds its claim, and reads `gone`. `abort` is
safe only because a person runs it, at the holding machine, where the dashboard shows whether that session is idle-and-resumable; the skills' prose says to
check before aborting. The same fact is why bug-49's groomed second half — a server-side sweeper releasing every own-host claim with no registry entry, once per
poll — was withdrawn in review before it merged: on the board's primary dispatch path it would have released a groom session's claim the first time it asked
a question, and a released claim is permanent. A reply wait is unbounded, so no heartbeat grace shorter than `CLAIM_STALE_MS` covers it, and one that long
adds nothing the protocol does not already do. An automatic release needs a signal that separates "stopped" from "between turns" — the dashboard's own
session state is the candidate — and that is a follow-up to groom, not a variant of this check.

Rejected, each for its own reason. **A `--force` flag, or a clause letting any caller name the holder**: the clause with no proof attached, assertable from a
machine that cannot possibly know, which is the shape bug-46 exists to stop being persuasive. **Host equality with no liveness check**: cheaper, and it would
let a second session on the same laptop take an item out from under the person holding it at a terminal — the check is what makes `abort` a repair rather than
a seizure. **Shortening `CLAIM_STALE_MS` for hand claims**: backwards, since the alias exists so a hand claim can be given a LONGER window, nothing
heartbeating a hand groom automatically. **A remote path for a machine that is switched off**: the honest answer is the fifteen minutes, because a machine that
cannot answer cannot prove anything. And the boundary all of this draws is a MISTAKE boundary, not a security one — `stop` has always sent a caller-supplied
`session` that the server compares against the record, and the holder's id is printed in the refusal, so a determined caller could always have released
somebody else's claim. The question a clause can answer is not "can this be forged" but "is the caller in a position to KNOW".

**A heartbeat names its author, and only the holder or its run may beat (bug-45).** `heartbeat` was the one write route that authenticated nobody: the request
carried no `session`, the type had no field for one, and the adapter asked only whether the claim was released. Two harms, and the second is the one that cost a
day of two machines' work.

The first is mechanical. A rival's heartbeats keep the HOLDER's claim live forever, so the fifteen-minute staleness repair never fires for the one issue that
has two sessions on it — the exact case the repair exists for. The second is that a 201 from this route reads as proof of ownership. On guide-manager#5 a
session lost the race, watched its own comment be deleted (the protocol working exactly as designed), spent forty seconds hunting `~/.claude` for the winner's
session id, found nothing it could compare against, ran `heartbeat` as an "is this claim mine?" oracle, got exit `0`, wrote "Claim is this session's (heartbeat
accepted)" and groomed an issue another machine was already executing. Every layer behaved as written; the answer was wrong because nobody had been asked who
was calling.

So `ItemHeartbeatRequest.session` is required — a 400 with no name, exactly like `release`'s — and `runId` is the same optional assertion `release` takes, with
the same `typeof`/`length` guards for the same reason. The rule is **the holder always, the RUN that owns the claim, and nobody else** — `release`'s quadruple
minus its last two clauses, and the same reason drops both. NOT "anyone once the claim is dead", and NOT "the host that can show the session is gone": each of
those is about ending a claim, and there is no reason to end one through the beat route when `release` is right there. `release` lets anyone retire a dead claim
because retiring one is tidying; REVIVING one is the harm — a stranger's beat on a stale claim is what makes the staleness repair unreachable. Retiring a dead
claim stays
`claim`'s business, which the protocol already answers by the lowest live comment id. The check runs BEFORE the released branch, `finished` included: a stamp is
still a write to somebody else's record, and `finish` sends its run's `runId`, so a driver's own claims pass the same-run clause whether or not their terminal
stage released them first. Both callers name themselves — `backlog.mjs heartbeat` sends `sessionIdentity()`, `orchestrate.mjs`'s `trackerHeartbeat` and
`trackerFinish` send the driver's session plus `run.runId` — and the CLI renders the 409 rather than letting a bare status reach a skill.

**A claim says WHERE its holder is, because a session id is the one identifier a remote reader cannot resolve (bug-46).** `ClaimRecord.session` is
`CLAUDE_CODE_SESSION_ID`, which names a transcript under `~/.claude/projects` on exactly one host — and for phase 3 that was the whole of what a claim
published about a holder. So the one check a reader on another machine can actually run, looking for that session locally, answers "no" for every foreign
claim, live or dead. Both questions have the same answer shape, the second is the one that gets asked, and its "no" was read as the first one's. On
guide-manager#5 a session on the mac lost the race, received the correct refusal with `heartbeat 12s ago` in it, went looking for a better answer than the one
it had, found no transcript, concluded "litter from a claim-race experiment", and scheduled itself to take the item the moment the staleness window expired —
while the Linux machine was mid-execute on it. The false negative is worst in exactly the case the protocol exists for: a claim whose holder is on the OTHER
machine is the only kind a lock is needed for at all.

`host` is `<user>@<host>`, optional, and **absent means "the machine was not recorded", never "local"** — a reader must not be able to infer that a hostless
claim is its own. No `v: 2` for it: `parseClaim` accepts `v: 1` and passes unknown fields through, so an old build ignores the field and a new build reading an
old claim says less rather than throwing, the precedent `run` and `state` set. And `session` is not widened into `<session>@<host>`, because it is an equality
key — `stop`'s holder check, `heartbeat`'s and `release`'s author tests and `claim`'s same-run takeover all compare it raw — so a composite value would stop
matching across a version gap and a new build could not release a claim an old build wrote. The identity and the address are two fields precisely so one of
them can change shape without breaking the other.

It is **sent by the CLI and never derived by the server**, which is the one line of this that looks like an accident and is not: the server may be running in
the compose stack, where `os.hostname()` is a container id rather than the machine anybody is sitting at. `backlog.mjs` and `orchestrate.mjs` each carry their
own two-line `hostIdentity()` — a skill's `tools/` may never import another's, so the duplication is the rule rather than a shortcut.

What it buys is narrow and worth stating: **the removal of a false NEGATIVE, not new proof of life.** Liveness evidence was never missing — the refusal said
`heartbeat 12s ago`, which is the answer — and a hostname is still just a string a determined session can rationalise around. What stops being true is that "I
cannot find this session" is evidence of death. That is also why an absent host prints as NOTHING rather than as `unknown`: an empty value reads as "not
recorded" the way an empty `claim-session:` reads as "unheld", where `unknown` is a word a session can argue with. For the same reason a refusal whose holder
has no host degrades whole, naming neither machine: a line that says where we are beside a blank where they are invites the very inference this bug is made of.

**"Is this claim mine?" has to be answerable without a network call, so three commands print both sides.** The identity half of bug-45, and it is not cosmetic:
`sessionIdentity()` existed from task-46 and no command had ever printed it, so a session could read a holder's id and have nothing to compare it against — the
losing session on guide-manager#5 even probed the wrong variable (`CLAUDE_SESSION_ID`, unset) trying to find out. `start`'s lost-race line and `heartbeat`'s
refusal both carry `— this session is <id>` — on `start` the rule bug-47 appended follows it rather than ending the line — and `show` prints `claim-session:` and `this-session:` in its frontmatter-shaped block, with `--json` carrying
`session` beside the `claim` it already returned. `claim-session:` is EMPTY rather than absent on an unheld item: a key that disappears is a second shape every
reader has to branch on. Bug-46 puts `claim-host:` and `this-host:` beside them under the same empty-never-absent rule, and adds nothing to `--json`: the claim
object it already returns carries `host` on its own, and the reader's own machine is something a reader can ask their own OS for — unlike a session id, which
is why bug-45 had to print that one.

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

**The mapper reads liveness NOWHERE.** `mapIssue` fills `started`/`phase` from the lowest-id UNRELEASED claim (`heldClaim` — lowest for bug-58's reason:
a race loser's comment is newer and stays unreleased until it is deleted; #348) without consulting its heartbeat, because the board's rule
for a files item is "ANY stamp, fresh or stale" (`progressBlock`), and what retires a stale claim is the PROTOCOL, at the moment another session contests the
issue. A mapper that expired claims on its own would show an item as free while the next `claim` call still had to fight for it. The BOARD ages it instead
(#227): `claimReading` on the client reads `holder.heartbeat` by the reader's clock, so a stale claim still carries `started` and reads `stale`, not `executing`. The counters come off the
newest claim whether or not it is released, because they are the item's running totals rather than a fact about who holds it.

## An outsider's tracker issue is executable only while its body matches a pin a groom of ours wrote

#341, from the 2026-10-24 audit (one new security Important, two still open from the one before) — #266's pieces 3 and 4, the half #362 left for a design
pass after closing the claim-comment half. **The hole.** A tracker project may sit on a PUBLIC repository, and `backlog.mjs connect` installs issue forms that
apply `type:*` for whoever files them. Readiness was decided from labels and headings alone: `groomed` is `deriveGroomed` over the body, and every execute gate
— `trackerExecuteCandidate` in the tick, the orchestrator's `trackerCandidates`, the board's Run, the server's `plan`/`dispatch` re-check, execute's own
refusal — trusts it. So a stranger could file a Task, fill `## Plan` and `## Done when`, and the next idle tick would run `backlog-execute --finish pr` on it:
a stranger's instructions handed to a headless session with this machine's tools, its `Done when` commands shelled out. Separately, nothing recorded WHICH
body a groom approved, so an issue's author could rewrite the plan after a person had read it, and execute would read the live body.

**Why the gate is on the AUTHOR, not on every issue.** On GitHub only an issue's author and accounts with write access can edit its body. A trusted author
(`OWNER`/`MEMBER`/`COLLABORATOR`) therefore means every possible editor of that body is trusted, and the only issues that need a vetting record are the ones an
outsider filed. Gating every issue instead was weighed and rejected: it would have locked every already-groomed item on every tracker board until somebody
re-groomed it, to close a hole that only exists for one kind of author. The trust rule is ONE function, `trustedAssociation`, shared with `trustedAuthor` —
the claim-comment check #362 added — so "who is inside the repo" cannot mean one thing for a comment and another for an issue. Absent is trusted there for
the same reason: every issue and comment the API returns states an association, so only an object built in a test lacks one.

**Why the pin lives in the claim comment, and not in the body.** The obvious record — the `bm:groomed-at` footer `body` already writes — lives IN the body, and
the body's author can type it; it also names a commit, not a body. The claim comment is the one record on an issue that only a trusted account can carry:
`parseClaim` drops every comment whose author is outside the repo, so an outsider can neither forge a pin nor post one. It is also already server-written and
per-session, old builds ignore an unknown key in it (`v: 1` passes unknown fields through, the precedent `host` and `run` set), and a second comment kind would
have needed its own parser, its own trust check and its own place in the poller. A released claim still counts — a groom's claim is released by its own
`stop`, and the pin has to outlive that — and the newest well-formed pin is the one compared, so a later groom supersedes an earlier one.

**Why it is written at `body`, not at `stop`.** The pin has to be the hash of the body THIS server wrote, and only the `body` route knows that body: it hashes
GitHub's own PATCH response, inside the same per-URN write chain, so no other local write to the item lands between the PATCH and the pin. Pinning at `stop`
from a fresh read would capture whatever the issue says at the moment of stop — including an outsider's edit made between the groom's write and its release,
which is exactly the edit the pin exists to catch. And it is written only into a LIVE claim the calling session holds: the pin says "a trusted session wrote
this body while it held the item", and a claim somebody else holds, or one already released, cannot vouch for a write it did not make. That is also why the
caller's `session` rides on the request — the claim is the only proof the server has of who is writing.

**Why `groomed` keeps its meaning.** Folding vetting into `groomed` would have reused every gate for free, but it would break "groomed is derived from headings"
and draw an outsider's filled-in bug as ungroomed, which is false — it HAS a plan; nobody trusted has read it. So `unvetted` is a separate flag on the ladder
`planReview` already built, in every place that ladder sits, and one rung ABOVE plan-review: approving a plan does not vet it, so an item carrying both must
say the reason the approval would not clear. For the same reason removing `plan-review` does not vet — the approval route has no claim to write into — and the
tick does not groom an unvetted bug (it is `groomed`, so it is no groom candidate): vetting a stranger's plan is a person's groom, or a trusted session's.

**Every failure points closed.** No session on the request, or no live claim held by it: no pin, the write still lands, and the item stays unvetted — a
re-groom by hand is never refused. A claim read or edit that fails after the PATCH landed: a 201 carrying `pinWarning`, never a refusal, because the write it
reports did happen, and the item stays unvetted. A malformed `pin` is ignored by the mapper rather than refused by `wellFormed`, because the claim still
governs who holds the item and a bad pin must not cost the holder that; ignored means unvetted. A body edited after the pin hashes differently and gates every
reader off until a trusted groom pins it again — which is also what closes "execute reads the live body": the session reads the same cached copy the flag was
derived from. Ideas, refactors and out-of-scope never carry the flag (nothing executes them, and a refactor's promotion files a new, trusted issue), and a
files item never does — a file reaches `backlog/` only through a commit, which is already the repository's own vetting.

## `orchestrator:queued` is a plan, never a claim

Task-52, [the orchestrator:queued spec](../superpowers/specs/2026-09-23-orchestrator-queued-label-design.md). A run on a tracker project claims one issue at a
time, so every other item in its queue looked, to a teammate on github.com or another machine's board, exactly like an unplanned open issue: a person picked one
up, the run reached it an hour later, lost the claim at preflight and skipped it. Nobody did anything wrong and both sides lost time. The fix is a SIGNAL — one
label, `orchestrator:queued`, on every issue a live run still means to reach, filterable in GitHub's own UI and drawn on every machine's board.

**Why advisory, and why nothing may read it as exclusion.** The claim protocol above is the only mutual exclusion this system has, and it is convergent because
it is ordered comment ids with no clock. A label has no order, no owner and no heartbeat; a lock built on it would be a second, weaker protocol that two
machines could disagree about. So no gate, queue builder or claim reads the label — a human who claims a queued item by hand is doing nothing wrong, their won
claim simply wins, and the run skips the item at preflight exactly as it did before the label existed. It is not the assignee either: the assignee means "who
last worked this", and setting it for a plan would make a queued item indistinguishable from a worked one. The same reasoning makes every driver-side write
best-effort: a failed add at `init` or a failed remove at a skip prints one stderr line and the run continues, because parking a run over a cosmetic hint would
trade real work for it.

**Who adds and who removes.** The driver adds it at `init` to every item of the queue as built, already cut to `--max`. The server's won `claim` removes it in the
same step that adds `in-progress` — the claim swap — because the claim is the moment an item stops being planned and starts being worked, and every claimant, a
run, a hand session or another machine, goes through that one method. The driver removes it on a skip and sweeps it off every never-claimed item at `finish`
and at `--abort`. A pause keeps it: a paused run still plans those items.

**Why the server sweeps at Stop, not only the driver.** The driver reads a stop request only at its dispatch gates, so a Stop pressed early in a long execute
session would leave the whole queue labelled for that session — the opposite of what a stop says, which is that the plan is off. A dead driver reads nothing
at all. The server holds the token and can read the run file's queue, so `AgentsService.stop` sweeps every never-claimed item itself, through the item writer
(never `GithubClient` directly, so the per-item lock and the refusal mapping stay in `items/`), before the abort spawns. The sweep never fails the stop: the ids
it could not clear come back in `StopResult.unqueueFailed`, and the spawned `--abort` sweeps again as the backstop — idempotent by the route's 404 rule. A
`files` project has no writer, so its stop asks nothing.

**Why stale is drawn, not hidden.** A crashed run, a run on another machine that died without its Stop, or a label added by hand all leave the label on the
issue with no live run behind it. Hiding the strip then would make the board disagree with GitHub's own issue list, which still shows the label, and would
hide the one thing a reader can act on — remove the label, or Stop the crashed run when it is this machine's. So `queuedReading` (`client/src/lib/tracker.ts`)
answers `'live'` only while a local run is `running` and not crashed, or `paused`, or a remote run for the same repo is live; otherwise `'stale'`, drawn as a
dimmed `queued · stale` band whose title says why. `paused` is accepted on its own because `runIsLive` is `running`-only, and a paused run is still the run that
queued the item.

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
releases it at the item's terminal stage, or at `abort` for anything that never reached one (bug-40, below). Parking is one of those terminal stages, and a
parked item is regularly carried forward by hand once its cause is fixed, so the first `stage` out of `parked` to a non-release stage claims again (#250) —
without it the item ran review and verification on a released claim, every heartbeat refused, and the issue free to any other machine. The dispatched `backlog-execute` session never
runs `start`, `stop`, `heartbeat`, `move` or `comment` on the item at all, which is the exact opposite of the files arrangement, where execute stamps the item
file itself.

**A re-claim out of `parked` bills only what came after the park (#267).** The new claim is seeded from the newest prior one's counters, and those are the ones
the park's release just wrote — the item's `usage` as it stood then — so a release that summed the whole of `usage` again billed the pre-park spend twice.
`stage` therefore records what the seed already carries as `claimBilled` when it takes the claim, and the next release bills the difference, floored at zero.
A total rather than an entry index, because `usage` replaces an entry by slot and a resumed driver re-recording a pre-park transcript moves no index; only a
difference of totals bills that as nothing. And only in `stage`, never in `claim`: a resumed driver's takeover inherits a claim that was never released, whose
seed has billed none of it.

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
  would report a finished item as unfinished. A dangling live claim goes stale within `CLAIM_STALE_MS`, which is the protocol's own repair — **of the protocol
  only.** Going stale entitles the next contestant to retire the claim; it does not remove the `started` stamp the board reads, so the cost of a release that
  never happened is paid on every machine's board until a person runs `backlog.mjs stop <id> --abandon`. That asymmetry is why bug-40 made `abort` release
  rather than leaving its claims to age out: a rare failed release is worth the trade, a systematic one is not.
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
(`run.json`, `runs/` and, since #322, `stale-plans.json`), which is exactly the property that makes a new sidecar directory free.

**That snapshot is re-fetched from the live issue, so `verify` refuses any `## Done when` command the gate never saw (bug-253).** The gate checks a command
against `backlog/verify.json` and the `package.json` scripts once, at gate time; whoever can edit the issue could otherwise add a fenced line after that and have
this machine run it unattended. The gate's check is only a question, though — a human answer or `questionMode: decide` clears an unlisted command, and that item
must still verify. So `stage <id> preflight`, on the transition that takes the issue, records the body's `## Done when` commands in `<dir>/items/<id>.gate.json`,
and `verify` runs a command only if the allowlist approves it (read at the project root, never in the worktree the session can write) or that record holds it.
Anything else refuses the whole verify with exit `11` — nothing run, nothing written — and the driver stages the item `needs-answers`. A missing record fails
closed, to the allowlist alone. A files item needs no re-check: its `## Done when` is the committed file the gate read.

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

And **`abort` gives every claim the run still holds back** (bug-40) — the same "still holds" predicate `heartbeat` uses, over the same queue, immediately
before `abort` delegates to `cmdFinish`. Until bug-40 the only caller of `trackerRelease` was the `stage` path's `CLAIM_RELEASE_STAGES` check, and an abort
ends the RUN rather than walking each item through a terminal stage, so every claimed item was left with an unreleased claim, the `in-progress` label and the
assignee still on its issue. Five things this entry pins, because each looks arbitrary from the code alone:

- **The reason is `'aborted'`, and it must not be a `RunStage`.** `deriveRemoteRuns` reads a release reason as the item's stage when it happens to be one and
  otherwise falls through to `state.stage`, so this spelling leaves the item's last reported stage intact on every other machine's Runs page.
- **The release runs before `finish`.** `finish` stamps `finished` on the last-touched CLAIMED item, and `item.claim` survives a release, so the stamp still
  lands — on an already-released claim, which is exactly the case `GithubSource.heartbeat` accepts and where it sets `finished` and nothing else.
- **Counters are billed the ordinary way**, read through `claimCountersFor` rather than omitted: the session did the work it did up to the abort. This is not
  `backlog.mjs stop --abandon`'s dead-interval case.
- **The marker-preserved item is released too.** `abort`'s marker branch that skips an item's git teardown — a worktree still carrying an in-progress
  `phase:` marker, or, for a tracker item, which has no file to carry one, a worktree whose item is still staged `dispatched` (#265) — leaves the work in place,
  and an item left in place still needs its claim back, because the run that held it is over either way. A files run makes no request on any path, since `trackerRelease` returns immediately with no `claim`.
- **`takeOverRun` runs BEFORE the release loop, and that order is load-bearing** (bug-42). The abort session is not the holder of any of these claims — the
  driver that posted them is, and on the path this exists for it is dead — so each release is authorised by `runId` alone, the "the RUN that owns the claim"
  clause above. Taking the run's lease first is what makes that assertion true at the moment it is made; moving the releases above the lease take would turn it
  into a lie. Until bug-42 gave `release` that clause, every one of these releases came back a 409 and bug-40's fix was proved only for the one caller a
  holder-only check admits: the driver releasing its own claims.

**Since #240 that loop is `finish`'s, and `abort` reaches it through its closing `cmdFinish` call.** An ordinary `finish --status done` or `failed` stranded a
claim the same way: `needs-answers` is left out of `CLAIM_RELEASE_STAGES` because a LIVE run comes back to the item, and a finished one never does, so a parked
question kept its claim — and its disabled dispatch control on every board — until someone ran `backlog.mjs stop` by hand. `finish` now releases every claim
the run still holds on every status but `paused`, whose resume returns to those items. The reason is `aborted` for an abort and `finished` otherwise — neither a
`RunStage`, for the reason the first bullet gives — and every point above still holds of the moved loop: it runs after `takeOverRun`, before the `finished`
stamp, and before the `orchestrator:queued` sweep. One loop in the command both paths reach is one release per claim; a copy in each would send an abort's
releases twice.

**Why this was worth a bug rather than the non-goal task-48 recorded it as.** The non-goal's stated rationale was that leftover claims "go stale on their own
in 15 minutes". That is true of the claim protocol's CONTEST rule and false of the board: the mapper fills `BacklogItem.started` from any unreleased claim,
fresh or stale, and `progressBlock` gates on `started` being present rather than on its age, so the item's dispatch control was disabled on every machine
indefinitely rather than for `CLAIM_STALE_MS`. The defect was the missing release, not the way the stamp is read — `progressBlock` and the mapper are
deliberately unchanged, and so is `GithubSource.release` leaving the assignee alone as the record of who last worked the item. (#227 later taught
`progressBlock` to age a HAND tracker claim and `release` to unassign on `stale`; a run's claim, which is what this section is about, still blocks until it is
released.) Items stranded by a past abort
are recovered by hand with `backlog.mjs stop <id> --abandon`; there is no migration.

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
never as nothing" holds for a remote run too. The stamped claim's own heartbeat is excluded because `finish` on an unreleased claim (a `needs-answers` item under a `paused` finish — every other status
releases it first, #240) moves it to the server's clock, milliseconds after `finished.at`; a resume never needs it, since a re-claim is a takeover that posts a NEW comment. A released claim whose
`reason` is a stage reads as that stage — the driver releases at a terminal stage without a final state heartbeat, so `state.stage` is the one before.

**A `stale` release is not the run's own stamp, so it never moves `updatedAt`** (#295). `updatedAt` — what the Runs detail sheet's "last heartbeat" and the
elapsed time are read from — is the newest of every claim's `heartbeat`, `released.at` and `finished.at`, skipping `released.at` when its `reason` is `stale`.
That release is written by whoever retired the claim as dead — `GithubSource.claim` in ANOTHER session's takeover, or a person's release route — so counting
it stretched a run that died 19 s after its claim to the reaper's clock, a day later (run-20261016-163408). `test/remote-runs.test.ts` R-11b pins the case.

**A remote run is read-only, and says so.** Pause, resume, abort and the watchdog are all local mechanisms on the machine holding the run file, so the Runs
detail sheet draws `Remote run: its controls are on the machine that ran it.` in the controls' slot and never fetches `archive/run`. A queue holds only what
the run has CLAIMED, and the sheet says that too; a LOCAL run of a tracker project that has claimed nothing says it is not visible from other machines.

## `backlog.mjs` in a tracker project needs the stack up

Task-46, spec §6.5. A project whose committed marker says `github` has no item files, so every command routes through the backlog-manager
API on this machine, which holds the credential and does the writing. A project with no marker never reaches any of that code: `files` mode runs the same
synchronous path it always did, and `test/…/backlog.test.mjs` asserts a files fixture makes zero HTTP requests across
`init`/`new`/`show`/`board`/`start`/`stop`/`move`.

**Mode is read from the marker and nothing else**, by `sourceMode` — the CLI's own copy of `resolveSource`, restated rather than imported for the reason the
label list is: a plugin skill's `tools/` is a standalone copy of what was pushed, with no build step and no path back into this repo. It carries the same
load-bearing negative: a marker this tool cannot read is exit `1`, NEVER a fallback to files. Falling back would write item files into a project whose items
live on GitHub, on one machine, where nothing would ever report them missing.

**There is no offline queue, deliberately.** A write parked on one laptop would be a second source of truth for an item's state, invisible to every other
machine — which is the exact failure the tracker-backed direction exists to remove. A refused connection is exit `5`, a new code, naming the port and both ways
to start the stack. A new code rather than reusing `1` because "the store said no" and "there is no store reachable at all" are different things to a caller and
the second has the same fix every time.

**`jira.mjs` needs the stack ALWAYS** (Jira phase 4), which is why it shares this headline rather than having a "tracker project" qualifier of its own. A Jira
ticket has no local store to fall back to — there is no files mode to be in — and the token exists only in the server, so there is nothing an offline path
could do. Its exit-`5` sentence differs from this tool's on purpose: it runs in a MAPPED repository, where `pnpm run dev` starts something else or nothing, so
it names the backlog-manager checkout the two commands belong to.

**`jira.mjs worktree` is the one exception** (Jira repo/branch, spec §6). It makes no API call at all — it is git only (`fetch`, `worktree add`, a
`merge --ff-only` on a clean tree, two lines in the repository's `info/exclude`) — so it works with the stack down and never exits `2`, `3` or `5`. Its own
codes are `0` (the tree is ready, its path printed as one JSON line), `1` (usage) and a new `4`: git refused, or one of the re-checks that guard a Run stopped
it — a New branch that already exists, a Continue branch held by the mapped checkout or diverged from `origin` — and nothing was changed. The exception is
the command's, not the tool's: every other `jira.mjs` command still needs the stack and still says so with `5`. It is also the tool's first git-writing
command, and it writes only into the tree it was asked for, the way `orchestrate.mjs worktree` does: no `--force`, no `-D`, no `prune`, no `reset`, no merge
but `--ff-only`.

**`review <id> on|off` is a plain tracker verb, not an exception.** It sets the `in-review` label through `POST /api/items/review`: API only, exit `5` with the
stack down, and refused in a files project, which has no label to carry. There is no local-file verb left in `backlog.mjs` — `config`, which read and wrote a
committed file for execute, was the one, and it went when the mode became a trigger flag; in a tracker project the only command that skips the stack is
`jira.mjs worktree`, above.

**`main` is async, and the entry guard awaits it.** The "every skill CLI exits through `process.exitCode`" rule is about `process.exit()` truncating a
pipe, which asynchrony has nothing to do with; what it actually requires is that nothing hold the event loop open when `main` returns. Every `fetch` here is
awaited to completion and each carries `connection: close`, so no pooled socket outlives the call. The source guard accepts `= await main(` for this file,
`api-call.mjs` and `jira.mjs` — the three whose work is a `fetch` — and still requires the synchronous form of `orchestrate.mjs` and `retro.mjs`, which hold no
asynchronous work at all.

**Three spellings, one issue.** `31`, `#31` and this project's own URN all name the same item, because three different callers arrive with three different
handles — a person types the number, a skill's prose says `#31`, and the board posts `BacklogItem.path`. A file-shaped id (`task-31`) and a URN naming another
repository are each refused with their own sentence: the first is a habit carried across from a files project, the second is a caller asking this project's
credential to write somewhere else.

## `import` writes the marker first and deletes the files last

Task-50, spec §8 — phase 5 of the tracker-backed direction, and the phase where a project stops having item files at all.
`backlog.mjs import github [owner/repo] [--no-forms]` moves a whole `backlog/` store onto GitHub issues through the local API, in one shot, and the ORDER of its
two writes to the repository is the entire design: the marker goes down first, the item files are deleted last, and everything else happens between them.

**The marker cannot go anywhere but first.** Every request `import` makes is one of the existing item write routes, and `ItemsService.writerFor` answers
`files` — a 400 reading `this project's items are files — the skills write them directly` — for a project whose marker does not yet say `github`. The 2026-09-17
draft of this design had the marker written LAST, on the reasonable-sounding argument that a project should not claim to be tracker-backed until its issues exist;
that draft could not have worked at all, because the first `create` it made would have been refused by the server it was talking to. This is not a bug that
shipped and was fixed. It is a design that the phase-3 guard made impossible, which is a better outcome and worth recording as one: the invariant "the server is
the only writer of a tracker project's items, and it refuses a files project" did the work here that a test would otherwise have had to.

**The deletion is the transaction's commit.** It runs after pass 2, outside both `try` blocks, and nothing else in the command deletes anything. That ordering is
what makes every failure recoverable by re-running: a refusal from §8.1 leaves the project byte-identical, and a failure part way through leaves the marker, the
issues created so far, and EVERY item file — including the files of items whose issues were never created, which are at that moment the only copy of them
anywhere. A `try/finally` around either pass would be exactly wrong for that reason. The command never commits and never pushes: the marker and the deletions are
one change on the repository and have to be staged together by a person who can read the printed list.

**The footer is the idempotency key, and it lives on the tracker.** Each issue body ends with `<!-- bm:imported from=<id> created=<date> tags=<tags> -->` and a
readable `_Imported from backlog/<path>_` line. A re-run rebuilds `old id → #n` by reading each indexed issue's body and parsing that comment, prints
`resuming: <k> of <total> item(s) already imported`, and skips those items in pass 1. Two properties make this the right place for the record. It survives a crash
that killed the importing process between two requests, which a local file would not; and it cannot disagree with the tracker, because it IS on the tracker. **The
comment and the readable line are two different things** and only the comment is ever parsed — the line is for a human reading the issue, and rewording it is a
prose change, while rewording the comment would break every resume. An issue with no footer is skipped when the map is built: it is somebody's own issue, filed by
hand, and taking a number off it would map an item onto a stranger's work.

Three rules keep that key intact across resumes, each learned from migrating this repo's own backlog. The LAST marker in a body is the one parsed, never the
first: the footer is always appended at the very end, while an item's own text can quote the marker format — and read from the top, such an item resolved to
`<id>` and was re-created on every resume. Pass 2's cross-link rewrite never touches the marker (`=` is an excluded left neighbour in `OLD_ID`): rewritten to
`from=#4`, the key matched nothing, and the next resume re-created every issue pass 2 had already patched — 72 duplicates here. And pass 2 prepends the
`_From #n._` line only to a body that does not already open with one, because a resume re-patches every issue a previous pass 2 reached.

The resume does exactly ONE repair, and the boundary is deliberate: a `done/` or `out-of-scope/` file whose issue the index still reports as `open` is a run
that died between `create` and its close (`state done` / `state out-of-scope`), so the close is made again. The counters are NOT re-billed. A second `claim` +
`release` pair would add a second permanent record of the same work, and a doubled record is worse than a missing repair — the counters are evidence, and
evidence that double-counts is not conservative, it is wrong.

**Counters ride one synthetic claim, released immediately, BEFORE the close** (spec §14.13). The four counters live in a claim comment (§6.4) and nowhere else,
so an item carrying any of them is given a claim whose session is `import-<stamp>` and which is released at once with `reason: 'imported'` and the counters
billed onto it. The order is forced from the other side: `claim` refuses a closed issue, so neither closed shape is closed at creation — a `done/` item is
closed by `state done` two requests later, and a rejected item that started life as a bug, task, idea or refactor is created OPEN under that section (keeping
its `type:*` label) and closed by `state out-of-scope` the same way. #219 is what happened when a rejected item was created straight into `out-of-scope`: the
adapter closed it inside `create`, the claim was refused, and a re-run skipped the item by its footer, so its counters were lost for good. Only a born-rejected
`oos-N` is still created closed, and since no skill bills counters onto one, an `oos-N` file carrying them is refused before the marker. The cost accepted here
is one extra comment per item that has counters, which is the cheapest of the options weighed — the alternatives were putting the counters in the body (they
would be invisible to every reader that knows where counters live) or dropping them (losing the only record of how long somebody spent).

**An over-cap body is cut at a `## ` boundary and links the full file at HEAD** (spec §14.14). `IMPORT_BODY_CAP` is 65,000, under GitHub's 65,536, and `fitBody`
keeps whole `##` segments from the top and appends `_Truncated. Full text: <SHA-pinned blob link>_`. Whole sections rather than a character count, because a body
stopping mid-sentence reads as corruption while one that ends after its last whole section and says so reads as what it is. The footer's length is subtracted from
the cap before fitting, so the footer always survives — a body that lost it to truncation would be re-imported as a duplicate issue by the next resume. The link
is what makes two of §8.1's refusals load-bearing: the link pins `backlog/<path>` at HEAD's sha, so HEAD has to be on some `origin/*` ref (otherwise the link
404s for everyone else) and `backlog/` has to be clean (otherwise the link shows bytes that differ from what was imported). A resume's one exemption is the
marker the stopped run wrote itself, while no commit carries it (`??` or `A `): the link never points at it, and without the exemption every resume refused on the
tool's own file (#218). A committed marker edited by hand is still refused.

**Three things are lost, and saying which is the point.** A body over the cap keeps only its leading sections plus the link. `tags:` survive in the footer alone,
because the tracker's label set is the closed eleven of `labels.ts` and inventing a label per tag would break that. And an item's git history stays in the
repository — the issue's date is its `created` frontmatter, not the commit that filed it. None of the three is recoverable from the tracker, which is why the
files' history is worth keeping in git rather than deleting the whole `backlog/` directory.

## The server never spawns git synchronously in a request path

Every git read the server makes goes through `runGit` (`server/src/git-run.util.ts`): `execFile`, promisified, so the event loop keeps turning while git runs,
with a 10 s timeout, and a `null` answer for every failure alike. The rule is that no `execFileSync`, `spawnSync` or `execSync` exists anywhere under
`server/src`, and `test/git-run.test.ts` fails on one.

### The incident

2026-10-15: a stray `find /` in the server container slowed Docker's bind-mount I/O. `git status` took 5–38 s inside the container against 75 ms on the host,
and because every git call in a request path was `execFileSync` or `spawnSync`, each one froze the whole Node process for as long as it ran. `/api/health` —
which does no I/O at all — took 23 s, `/api/projects` 16 s, `/api/agents/status` 20 s. The slow part was one repository's git; the outage was the entire API's,
and it looked like a hung server rather than a slow disk, which is the worst thing a loopback-only tool can look like. An async spawn trades that for the honest
shape: the routes that need git are slow, every other route answers normally. After the fix the route case in `test/git-run.test.ts` has `/api/health` answering
in 58 ms while `/api/items` waits 1.1 s on a fake `git` that sleeps for a second.

### Failure is a value, and a timeout is just another failure

Each call site already had exactly one failure branch, and each degrades rather than throws, so `runGit` answers `null` for a timeout, a non-zero exit, a spawn
error (`ENOENT`, a `cwd` that is not a directory) and an oversized output alike, and a timeout lands in whatever that site did with `null` before:
`lastCommitDates` → the empty map (every caller reads it as "fall back to `created`"), `uncommittedItemPaths` → `known: false`, `originRepo` → `null`,
`resolveBaseBranch` → the same 400 a missing branch gets, `AgentsService.branches` → an empty list, and `ReleasesService`'s four reads (2026-10-16, the release
chip) — `for-each-ref` → the empty shape, `describe` → `current: null` with the releases kept, `remote get-url` → no `url`, `rev-parse` → the answer is not
memoised. A command that succeeds and prints nothing answers `''`, not `null`, so `show-ref --quiet` callers test `!== null`. Nobody added a "timed out" branch,
because none of the nine has a reason to treat a slow repository
differently from an absent one; a site that grows one is making a new decision and should say so here.

**Ten seconds, not five.** The synchronous callers carried 5 s, and that number was a cap on how long the entire process could be frozen, so it had to be short.
Async removes the freeze; the bound now says only how long one request is willing to wait before it gives up with the degraded answer, and the incident's 5–38 s
spread says 5 s would have degraded healthy-but-slow repositories too eagerly.

### Sharing a pending spawn is `lastCommitDates`' alone

`lastCommitDates` costs a spawn per registered project on both `/api/items` and `/api/projects`, and it has a cheap, trustworthy key (the mtimes of `index` and
`logs/HEAD`, see the middle-rung rule). Async made a new failure possible: a burst of N requests landing while one slow git is still running would each miss the
memo and spawn their own, so the memo would be bypassed in exactly the situation, a slow repository, where it matters most, and the pile-up would be the
server's own doing. So concurrent misses for the same project **and the same fingerprint** share one pending promise. A caller under a different fingerprint is
not handed it, because that spawn began before whatever moved the key. The entry is dropped when its spawn settles, and a failed read is neither memoised nor
left pending, so the next call retries instead of the project being pinned to the `created` fallback until a commit moves the fingerprint.

`uncommittedItemPaths` and `originRepo` have no such sharing and must not get it. The uncommitted read's whole contract is "per request, memoised nowhere" — its
subject is the working tree, which the fingerprint does not watch — and a request that arrives after an edit must not be handed a read that began before it. Two
concurrent calls spawn git twice; `test/git-run.test.ts` pins that.

**`ReleasesService` is the one later sharer, on the same terms, so the heading above is narrower than the code** (the release chip, #290; since #301 the read
is release-kit's `createReleasesReader`). Its key is cheap and trustworthy for the same reason — the root, HEAD and the mtimes of `packed-refs` and `refs/tags`
under the common git dir — so concurrent requests under one key share one read, a newer key is never handed an older read, the pending entry is dropped when
it settles, and an incomplete answer is never memoised. Its git still goes through `runGit`, handed to the reader as its git port.

### What was left synchronous, deliberately

The synchronous `fs` reads (`readFileSync`, `readdirSync`, `statSync` in `orchestrator.service.ts`, `scan.util.ts`, `resolve.util.ts`) were not converted.
During the incident `ls -R` of a backlog took 76 ms while git took 38 s; they were not what stalled anything, and converting them is churn with no failure
behind it. The grep guard is for spawns only, and scoped to `server/src` — the skills' own CLIs (`skills/**/tools/*.mjs`) legitimately `spawnSync`, because
nothing there serves requests.

## The server never writes git

Every git command the server runs is a read: `rev-parse`, `for-each-ref`, `rev-list`, `symbolic-ref`, `show-ref`, `check-ref-format`, `log`, `diff`,
`ls-files`, `remote get-url`, `describe` and `worktree list`, each through `runGit`. Nothing under `server/src` fetches, adds or removes a worktree, checks
out, commits, merges or pushes; those are the session's — `jira.mjs worktree` on a Jira Run, `orchestrate.mjs` on an orchestrator run, a person in a terminal
otherwise. This was true before it was written down (Jira repo/branch, spec §6); it is stated now because the server started reading FOREIGN repositories —
the ones a Jira project is mapped to — whose branches and worktrees the board lists (`server/src/jira/refs.util.ts`).

**Why a read-only server, and not a convenient `fetch` before listing.** The ref listing the launch sheet draws is as of the repo's last fetch, and it says so
("as of last fetch, N min ago"). A server that fetched would be a process with no terminal reaching a remote with the person's credentials — a credential
prompt with nobody to answer it, a lock held against the person's own `git pull` — and it would be doing it in a repository it does not own, on a request
whose answer is only a list. The session that will work in the tree fetches first, retrying once on a lock, and the worst case of a stale listing is a
re-check refusal (exit `4`) the person can act on, never a write made behind their back.

**The Worktrees list's Remove copies a command; it never runs one.** Removing a worktree is the one destructive git operation the board offers, and it is
offered as text on the clipboard — `git -C <repo> worktree remove <path>` — for the same reason: a session the board did not start (Copy prompt, a terminal)
cannot be seen from here, and a tree it is using must not be pulled from under it by a click.

**Under compose the mounts make it physical.** Both project roots are mounted `:ro`, so a git write from inside the container would fail outright. On a
host-run API the mount is not there to catch it, which is why this is a rule about the code rather than a property of the deployment: a new git call under
`server/src` is a read, or it belongs to a session.

## A client poller built on `useCoalescedFetch` never has two of its own requests in flight

The other half of the same incident. While the server was stalled, the client's `setInterval` pollers kept ticking on the wall clock whether or not the last
request had come back, so each one stacked a fresh duplicate on every tick; when the server recovered it had a queue of identical questions to answer, most of
them git spawns, which amplified the stall. `lib/coalesced-poll.ts` (`createCoalescedPoll`, pure of React and tested directly with fake timers) and its React
shell `hooks/useCoalescedFetch.ts` are now the one home of poll scheduling for `useOrchestratorRuns`, `useBoard`, `useWatchdog`, `useAgents`, `useTicks` and — since
#285 — `useOrchestratorArchive`; none of them holds a `setInterval`. Every one of those six — and, since Settings › Dashboards, `useMachines`, a seventh that polls a minute while that page is open — enters through `hooks/useRefreshing.ts` (#285), which owns the
board's mount + window-focus triggers once instead of each hook writing the two effects by hand; `useCoalescedFetch` stays the lower layer, used directly by
`useJiraBoard`, which triggers on its board id rather than on mount and focus. `TimeZoneProvider` (#241) enters through `useRefreshing` too, with no `armed`
like `useOrchestratorArchive`: it reads the shared zone on mount and focus and never polls, since the value moves only on a person's pick. `ProjectsProvider`
(the source sections' one `GET /api/projects` read) enters the same way, for the same reason: the registry moves on a `register`, not on a clock.

**The timer is armed by an answer.** The next tick is a `setTimeout` set when the current request settles, `intervalMs` later, so a slow answer slows the poll
instead of piling onto it and at most one timer is ever pending. Each hook keeps its own `armed` condition for "something is moving worth polling" exactly as
its interval effect used to guard on it; flipping it false clears the pending timer on that render, and an in-flight request finishes without re-arming
anything. The watchdog's is the one condition that is not "something is moving": since #270 a live monitor never goes quiet, so its `armed` is `live`
alone and the sweeper's phase picks only the period — `WATCHDOG_POLL_MS` while armed, `WATCHDOG_IDLE_POLL_MS` otherwise — because the phase change it
waits for has no event on the page.

**A trigger mid-flight folds into one follow-up, not a drop and not a second request.** A mount, a window focus or an explicit refresh that lands while a
request is in the air must not start another one, but it must not be swallowed either: the request already in flight was issued before whatever the trigger is
about (the Resume click's spawn, the tab just returned to) and may answer the old state. So the trigger marks the poller dirty, and when the flight settles
exactly one follow-up runs at once, however many triggers arrived. Every caller that asked during the flight is handed that same follow-up promise, so the
answer it receives was requested after it asked. The timer re-arms from the last request of a chain, never from the one it queued behind, so a focus storm
cannot make the poll tick sooner than `intervalMs` after the answer on screen.

**`useTrackers` is the deliberate exception, which is why the rule is scoped to hooks built on `useCoalescedFetch` rather than stated for every client
poller.** It is not built on this: it aims its own timer at the server's poll clock, and its focus refetch, the timer's read and `saveInterval`'s refetch can
all be in flight at once. It keeps correctness a different way — each read takes a sequence number and a superseded one does nothing when it settles (#231) —
rather than by preventing the overlap. `/api/trackers` reads `originRepo` per files project, so it is a git-backed route and a candidate to move onto the same
footing later; until then a window focus during a `/api/trackers` timer read can legitimately show two pending requests. `useNow`'s `setInterval` is a display
clock, not a request.

**`useJira` is the second exception (Jira phase 2), and for the same reason rather than a new one.** `GET /api/jira` is the Jira poller's status, and the
reading worth having from it is a board's `polledAt` moving just after the server's sweep stamped it — so, like `useTrackers`, its timer is aimed at the
server's clock (the soonest syncing board's `polledAt` plus its interval plus `useTrackers`' own `TRACKER_FETCH_SLACK_MS`, floored at
`JIRA_STATUS_FLOOR_MS`, and no timer at all while unconfigured or with no syncing board), not re-armed a fixed interval after an answer; a focus read, that
timer's read and a Setup save's `reload` can overlap, and it keeps the newest-read-wins sequence counter instead. Unlike `/api/trackers` the route reads no
git — it answers from memory, the env and `jira.json` — so the overlap costs a cheap read, not a spawn. `useJiraBoard`, the Board page's issue list, has no
server clock to chase and IS built on `useCoalescedFetch`. Both exceptions cover the fetch SCHEDULING, not the focus subscription: `useRefreshing`,
`useTrackers` and `useJira` all subscribe through one hook, `useWindowFocus` (#376), so what differs between them is what a focus asks for, never how it is
heard.

## ui-kit draws the version chip and the What's new drawer; this board only maps its tokens and places the chip

The version chip and the What's new drawer used to be two things in this repo: ui-kit's markup, and a block of this board's own rules laid over it — a pill drawn by
`.rail-release`, a drawer width, an edge, a lift, a notes size and a baseline rule restyled under `.uk-*` selectors. Each override was a small, reasoned departure
from the kit's defaults, and together they made this board's drawer differ from the other two apps' — the opposite of why the surface moved into a shared package.
ui-kit v0.3.0 took this board's look as its canonical one and moved every shape into the kit, which leaves the host exactly two jobs: map the public `--uk-*`
tokens onto the board's own, and place the chip.

**What stays here, and why it is enough.** `styles.css`'s `:root` mapping (each token pointed at a theme variable, so all five palettes carry through) and
`.rail-release`, a wrapper that sinks the chip to the rail's foot and makes it the phone menu's last row. `--uk-chip-bg` is mapped to `--steel` because the
kit's default is a light well that would show on a dark rail; `--uk-zoom` is mapped to `--font-scale` because `.shell`'s `zoom` leaves `100vw` and `100dvh`
meaning the unzoomed screen, and the kit divides its drawer's size by it — undivided, the panel overhangs the screen by the text scale. Notes go through the
kit's own escape-first `renderNotesHtml`, so a PR body is safe to set as HTML with no sanitiser here and a `###` line reads as a heading in every app.

**How a regression is caught.** `test/ui-kit-guard.test.ts` runs `ui-kit/guard`'s `checkHostCss` over each stylesheet this board ships (listed in the test, so a
new sheet is a deliberate add) and fails on any rule that restyles a `.uk-*` class or sets a `--uk-*` property that is not a public token. It cannot see a token
nobody mapped, so the same suite asserts the mapping sets `--uk-chip-bg` and `--uk-zoom`; `test/ui-kit-tokens.test.ts` holds every token the kit reads to being
mapped. If the board's look needs to differ from the kit, the change is a token or a prop in ui-kit, never a `.uk-*` rule here.

**The phone chip's hit area must not be clipped.** On a narrow layout the chip is passed `narrow`, which gives the 28 px pill a transparent 44 x 44 hit area that
overhangs it by 8 px above and below. `.rail` is `overflow-x: hidden` on a phone, which makes its y-axis clip as well, so the wrapper's margins and the rail's
padding keep the overhang inside the rail's padding box; an ancestor that clipped there would shrink the thumb target back to the pill.

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
  verified: 5a74ebf0f276cf9103c7a744f913c01f02e178f5
-->
