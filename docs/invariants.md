# Invariant rationale

The rules live in [CLAUDE.md](../CLAUDE.md); this file keeps the full
reasoning behind the ones whose "why" runs longer than the rule. Most of
these encode a failure that already happened or an attack that was closed
deliberately — read the relevant section before changing one.

## The orchestrator's run file has exactly one writer, one reader — the same relationship the registry has

The run file (`run.json`) is `orchestrate.mjs`'s entire state model for one
project's queue — the queue itself, each item's stage, the attention list,
timestamps — and every other consumer treats it as strictly read-only.
`server/src/orchestrator/orchestrator.service.ts` re-derives `orchHome()`
with its own copy of the same function rather than importing the `.mjs`
tool (a Nest service cannot import one), so the two implementations are
pinned to resolve identically by a comment on each side, not by the type
system — the risk that comment names directly: a mismatch would have the
board watching an empty directory while the CLI writes real runs a few
characters away. `OrchestratorService.runs()` calls `orchHome()` fresh on
every request and never caches — echoing RegistryService's own reason for
the same choice (a skill can act on its file at any moment; a cache would
show something stale) but for an even more time-sensitive case: a running
`orchestrate.mjs` re-stamps `run.json` on every heartbeat, and the entire
point of `GET /api/orchestrator/runs` is to let the board watch that happen
live — a cache would show a run frozen at whatever moment the server last
happened to read it. Neither the server nor the client ever writes a byte of
it; `orchestrate.mjs`'s own "Hard limits" section states the rule for the
skill side too — never hand-edit the run file, never `rm` it to get past an
exit code `4`, never write it from the server or the client.

The same one reader now also covers `runs/`, the archive directory
`cmdInit` writes to when a new run supersedes a finished one (`archivePath`,
`orchestrate.mjs`) — before this feature nothing ever read it back, so a
project's whole run history sat on disk with no surface showing it beyond
the drawer's own `pastRuns` count. `OrchestratorService.archive()` walks
every project directory under `orchHome()`, reading both `run.json` and
every `runs/*.json` sibling through the same skip-and-warn `readOneRun`
helper `runs()` already used for the current file alone, and returns them
flattened across all projects with `current: boolean` marking which entry
is the active `run.json` — a run file's own contents say nothing about
where it lives (`runId`/`status`/`startedAt` are identical in shape whether
the file is `run.json` or `runs/<runId>.json`), so the flag is the only way
a client can tell "the run still being superseded" from "one of however
many came before it." Verification tails are stripped to `{cmd, ok}`
(`VerificationSummary`, `shared/types.ts`) before the payload leaves the
service, because a tail is roughly 90% of a run file's bytes — a real 19KB
file is mostly test output — and `archive()` has to hold every run a
project has ever produced in one response rather than just its current one;
`archivedRun(project, runId)` exists for the one run a reader actually
opens, and serves that file verbatim, tail included. Two guards run before
either caller-supplied value reaches the filesystem: `RUN_ID_RE`
(`^run-\d{8}-\d{6}(-\d+)?$`) rejects anything not shaped like a run id,
closing off traversal before the first `path.join`, and
`encodeURIComponent(project)` is then checked for string equality against
an entry `readdirSync(orchHome())` actually returned — the same
allowlist-by-listing shape `server/src/items/allow.util.ts` uses for item
bodies, so an unregistered project path is never joined into a probe, only
compared against names the filesystem already listed. Every failure this
can produce — a malformed runId, an unknown project, no archived file and
no matching `run.json` either — collapses to the same `null`, and the
controller turns all of them into the same 404: `GET /api/items/body`'s own
stance, that the caller has no business learning which check failed. Both
new methods call `orchHome()` fresh per request exactly as `runs()` does,
and cache nothing — the single-writer rule above is untouched by any of
this; `orchestrate.mjs` remains the only process that ever writes a byte
under `orchHome()`, this service only reads more of what was already
there.

## `backlog-orchestrate` is the only skill that commits or merges

Every other skill in this repo edits item files and nothing else;
`backlog-orchestrate` is the first, and by this rule the only, one that
touches git history at all. It can, because of what it alone controls:
`backlog-execute`'s "never commits, never pushes" limit exists because a
headless execute session runs inside a tree it does not own, and staging
there could sweep up work that has nothing to do with it — an unscoped
`git add` in the user's own checkout is not a call any skill gets to make.
The orchestrator's worktree is different by construction:
`git worktree add .worktrees/<id> -b backlog/<id> main` creates a tree that
holds exactly one item's work and nothing else, so `add -A` inside it is
safe in a way it never is in the main tree — the skill says so explicitly at
the commit step rather than leaving the asymmetry to be inferred. The commit
itself is conventional-commit shaped, names the orchestrator as committer in
the body (so `git log` never implies a human read the diff before it
existed), and lands on `backlog/<id>` alone. The merge is
`git merge --no-ff --no-edit backlog/<id>` run against whatever the main
tree has checked out, and it is refused — parked, not forced — unless that
is first verified to be `refs/heads/main`; a run never checks out a branch
in the tree it does not own, either. No other branch is ever a merge target
and no other tree is ever committed to. Force-push, history rewrite, and
push of any kind stay off the table entirely — publishing to a remote is the
user's call, not this skill's, merge commits or otherwise.

## Undoing an already-completed orchestrator merge is `git revert -m 1`, never `git reset --hard`

This was proved empirically before the skill was written, not reasoned out
in the abstract: a pre-implementation spike ran `git reset --hard` to undo a
completed test merge, and it silently discarded an unrelated, uncommitted
modification sitting in the main tree along with the merge — gone with no
reflog entry to recover, because that modification had never been staged or
committed in the first place. The identical scenario undone instead with
`git revert -m 1 --no-edit <merge-sha>` left the unrelated modification
byte-for-byte intact. An unattended run can never prove the user's main tree
is clean at the moment it needs to undo a merge, so the choice is not
between a tidy history and a messy one — it is between a revert commit's
noisier `git log` and a tool that can destroy work nobody backed up. `-m 1`
names the first parent, `main` as it stood immediately before the merge in
question, which is what "undo the branch I just merged" actually means for
a merge commit (a plain `git revert` on a merge commit refuses without
`-m` — a merge has more than one parent and nothing to default to). This
rule is only about a merge that already landed; a conflict discovered
*during* the merge attempt is a different situation with its own answer,
`git merge --abort`, which leaves nothing to revert because nothing ever
committed.

## Merge mode is run-scoped, and a malformed one is a 400

On 2026-09-03 a board-spawned `claude-agents-dashboard` run finished four
items — reviewed, `test` + `typecheck` + `build` green on all four — and
merged none of them. Every merge attempt answered *"Permission for this action
was denied by the Claude Code auto mode classifier."* Two earlier runs, one on
the same project and one on this one, had issued the identical
`git -C "$PWD" merge --no-ff --no-edit backlog/<id>` and merged seven items
between them. Neither project had a `permissions.allow` entry at the time; the
dashboard's `.claude/settings.json` carrying `Bash(git merge:*)` is dated after
the failure, staged and never committed. **Nothing about permissions differed
between the runs that merged and the run that did not** — auto mode is a
per-call model classifier and its verdict on an identical command varies. The
full table lives in the skill's own
`skills/backlog-orchestrate/references/rationale.md`, §2.

*(2026-09-04 note: the skill has since dropped the `-C "$PWD"` clause from
both this command and the merge-mode probe (SKILL.md §2) — a no-op removed,
since the session's cwd was already the project root at every call site.
Claude Code's `permissions.allow` grammar matches an entry against the
literal command line by prefix, so `Bash(git merge:*)` — the very rule the
dashboard staged above — would not actually have matched the line quoted
above; it starts `git -C`, not `git merge`. Dropping the clause is what
makes that rule genuinely cover the command SKILL.md issues today. The
quote itself is left exactly as these three runs issued it.)*

Two consequences, and together they are the whole feature: merging is a
*choice* (a run that stops at four reviewed branches is a successful run), and
a run that wanted to merge and was refused *degrades to that outcome* rather
than parking work that is perfectly good.

The setting is chosen in a browser and consumed by a headless process on the
machine, so it cannot travel by `localStorage`, and the run file already has
exactly one writer. It rides the one channel that exists — the spawn prompt —
and lands in the run file, where every other fact about a run lives:
`orchestrateDefaultMergeMode` (client Settings, per-device, default `'merge'`,
clamped by the same `pickOne` as `dispatchDefaultModel`) seeds the
`OrchestrateSheet` picker; the sheet sends `mergeMode` on **every** launch,
including when it equals the default, because the field is the sheet's answer
to "what should this run do" and inferring it server-side from an absent field
would put one decision in two places; `AgentsService` validates it and appends
the compile-time literal ` --merge-mode branch`; `orchestrate.mjs init` writes
`mergeMode`, `mergeModeEffective` and `mergeModeNote`.

The service's rule differs deliberately from every neighbouring field. Absent
(`undefined` or `''`) resolves to `'merge'`; a member of `MERGE_MODES` passes
through; **anything else is a 400, uncoded — not clamped, not dropped.**
`model` and `effort` drop an unknown value because dropping one costs a
default model. Dropping an unrecognised `mergeMode` would resolve to `'merge'`,
and *merging to `main` is the irreversible direction*: a caller bug must not
be able to pick it. Absent still means `'merge'` because absent is not a bug —
it is every request written before this field existed. Uncoded because
`RUN_IN_PROGRESS_CODE` stays the one machine-readable answer this endpoint
gives, and nothing about a malformed enum needs telling apart from another 4xx.

Two run fields rather than one, because the archive has to answer "did this
run merge, and was that the plan?" months later. `mergeMode` is what was
asked for and is never rewritten; `mergeModeEffective` is what the run is
actually doing and only ever moves `merge` → `branch`, never back;
`mergeModeNote` says why they differ. Collapsing them loses the distinction
between a run that chose branches and a run that was denied them — exactly the
distinction the post-mortem above needed.

Enforcement of the mode lives in the tool, not in prose. `stage <id> merged`
exits `1` and writes nothing when `mergeModeEffective` is `'branch'`, naming
the stage it should have used. `SKILL.md` has to survive several hundred turns
of one session re-reading its own body; a tool refusal does not drift. The
converse is deliberately not enforced — `stage <id> branched` stays legal
under `merge` mode, because that is precisely what a denied merge degrades an
item to.

## `merged` is not the only success exit — `branched` is its branch-mode sibling

`branched` occupies the same terminal position `merged` does: `StageTrack`
stays seven nodes and the seventh carries whichever word this item actually
reached. It is a true exit — the run is finished with the item and holds
nothing — so it is out of `RUN_CLAIMED_STAGES` and out of
`ATTENTION_RUN_STAGES` (a clean branch needs nobody), out of `MACHINE_STAGES`
(a terminal arrival opens no span, the same rule "queue wait is not work"
already applies to `pending`), in `RECONCILE_TERMINAL_STAGES`, and counted as
completed by `aggregateRuns` alongside `merged`.

The cheaper option was to reuse `merged` and relabel it in the UI from the
run's mode — roughly half the work, and a stored history that states an item
merged when `main` never received it. This repo has repeatedly paid for
honesty in derived state over cheapness (`itemDurationMs`, `lastTouched`,
`isStale`), and a run archive that lies about what reached `main` is worse
than a mechanical sweep across the classification sites.

What keeps that sweep from being a checklist someone forgets is
`test/agents-shared.test.ts`'s `Record<RunStage, true>` literal: the compiler
demands an entry for every union member, and the test then forces each member
into one side of both partitions. The one place the mode alone is not enough
is `stepperDots`' terminal word — an item that has already reached one of the
two success exits answers with its **own** stage, and only an item still in
flight falls back to the run's `mergeModeEffective`, because a run downgraded
at item 3 must not redraw items 1 and 2 as having branched when they merged.

Not every `branched` stamp was written by the run that did the work.
`SKILL.md` §3's "Recognise a leftover branched item" step, run before
pre-flight on every item, can find a branch a *previous* run finished and
left waiting on a hand-merge, confirm it with an archive-move probe
(`git diff --name-only main...backlog/<id> | grep -q "/done/<id>-"`), and
stage it `branched` in the **current** run's own file without ever
dispatching, reviewing or verifying it. This is deliberate — re-running that
pipeline over already-green work would spend a whole item's budget re-proving
what a prior run already proved — but it does mean a `branched` entry in a
run's history is not proof that run executed the item, only that it correctly
recognised the item was already done.

## A classifier denial degrades the run; every other merge failure parks

The degrade is narrow on purpose. When the merge is refused by the classifier
the item is staged `branched` (not `parked`), the run records the downgrade
once with `merge-mode branch --note "<the classifier's message>"` so the rest
of the queue skips a merge just shown to fail, and the run continues to the
next item.

`parked` is wrong here, and correcting it is what this whole feature exists
for. Parked means a human must look at the work. Nothing is wrong with the
work — every step before the last was green, and the last step of the pipeline
was refused. Four green branches reported as four parks is what made the
2026-09-03 run read as a failure.

**No attention entry, and no fourth attention kind.** `ATTENTION_KINDS` stays
the closed set of three (`needs-answers`, `parked`, `fix-exhausted`): the
attention list means "a human must look at *this item*", and a verified branch
does not qualify. The cause is one run-level fact recorded once in
`mergeModeNote`; N items denied by one classifier verdict would write N
identical rows. The actionable part — the literal `git merge --no-ff
backlog/<id>` per branch, in merge order, with overlapping pairs flagged —
belongs in the run's finish summary, where it is one list rather than N copies
of one sentence.

**Every other §9 failure keeps its behaviour exactly.** A conflict, a
pre-merge refusal over overlapping dirty paths, a main tree not on `main` —
all still park, still keep the worktree, still say why. Those are genuine "a
human must decide" states and none of them is a permission problem.

The preflight probe in `SKILL.md` §2 — `git merge --no-ff --no-edit HEAD`,
once per run, merge mode only — is early warning for the same failure
and never a guarantee. Merging `HEAD` into itself prints `Already up to date.`
and changes nothing that matters (no commit, no index change, no reflog
entry, dirty tree or clean — it does refresh `.git/ORIG_HEAD`, the same as
any other `git merge`, harmlessly), and the command *shape* is byte-identical
to the real merge so the classifier is shown what it will be shown later. It
buys "find out in ten seconds instead of four hours" and nothing else: the
verdict is per call, so a
passing probe can still be followed by a denied merge, which is exactly why
the degrade path exists as well as the probe.

## `orchestrate.mjs` is always invoked from the project root, never from inside a per-item worktree

`resolveProjectRoot()` walks up from `process.cwd()` looking for a `.git`
entry, deliberately duplicating rather than importing `backlog.mjs`'s
identical walk (the file's own header comment gives the standalone reason).
Every command but `init` uses this instead of a `--project` flag to decide
which project's run file it means, because every one of them (`stage`,
`heartbeat`, `attention`, `finish`, `status`, `watch`, `abort`) is only ever
invoked by the orchestrator loop itself, whose own cwd is the project root
for the run's entire lifetime; `init` is the exception because it can
plausibly run from somewhere else — a server endpoint spawning the
orchestrator before its child process has even changed directory.

The contract used to be enforced by prose alone, and bug-2 is the record of
why that was not enough. A linked worktree carries its own `.git` (a file,
not a directory, pointing at the shared gitdir), so the old `existsSync`
test — which cannot tell a file from a directory — found it immediately and
resolved the WORKTREE's own path as "the project" instead of erroring. The
run was then keyed under `encodeURIComponent(<worktree path>)`, a directory
nobody else ever reads, while every other command and the server kept
keying by the registered project's own path. Nothing crashed and nothing was
corrupted; the run simply appeared to vanish, reported as exit `3`, "no run
exists" — the same code an unattended loop reads as "nothing to do." A prose
rule can only bind the commands the prose knows about, and the trap was
armed by anything at all that left the shell inside a worktree: the run that
surfaced it was broken by a one-off `pnpm exec jest --version` probe.

`resolveProjectRoot` now refuses instead, and so does `init` over its
validated `--project` value (the one command that never walks up from cwd,
and therefore the same hole from the other side). Exit `1` — a problem with
this call, nothing written — deliberately not `3`, which is the exact
conflation the bug was about. The discriminator is not "`.git` is a file":
it is whether the `gitdir:` target contains a `commondir` entry. A worktree
gitdir has one, a submodule gitdir does not, so a submodule working tree
still resolves to itself as it always did. The refusal names both the
worktree and the project root to re-run from, derived from those same two
files without shelling out to git, and degrades to naming the worktree and
its gitdir when the main tree cannot be determined (a bare main repo).

The invariant itself is unchanged — it just crashes loudly now instead of
answering wrongly. The per-item worktree and branch a command needs are
still passed as explicit values (`stage --worktree <path> --branch <name>`,
`verify --cwd <dir>`), never implied by cwd, and those flags are deliberately
exempt from the check: they name a worktree on purpose.

## `agents/` is part of the plugin's publish surface

Claude Code discovers a plugin's agents by the same directory convention it
uses for skills: every `*.md` in the plugin root's `agents/` directory
becomes an agent named by its own `name:` frontmatter key, addressed as
`<plugin>:<name>` — no declaration in `.claude-plugin/plugin.json` required
(confirmed against a second installed plugin, `caveman`, which ships three
agents with no `agents` key anywhere in its own `plugin.json`, and all three
load and are dispatchable). But an install is a copy of exactly two things:
whatever `PUBLISHED_PATHS` (`scripts/sync-plugin.mjs`) tells `plugin:sync`
to check for dirty/unpushed state and copy, and whatever the marketplace's
own sparse checkout on the installing machine actually pulled down,
declared as `sparsePaths` in that machine's `~/.claude/settings.json` under
`extraKnownMarketplaces.<marketplace>.source`.
Sparse cone mode carries root-level *files* automatically but only the
*directories* explicitly listed, so a root-level `agents/` reached neither
list until this task — `backlog-manager:backlog-reviewer`
(`agents/backlog-reviewer.md`) could sit committed and pushed in the repo
and still not exist in anyone's installed copy. Both halves have to be true
together: `PUBLISHED_PATHS` without a matching `sparsePaths` entry means the
checkout never fetches the directory for `PUBLISHED_PATHS`'s own dirty-check
to find; `sparsePaths` without `agents` in `PUBLISHED_PATHS` means the
directory is on disk but `plugin:sync`'s hash/dirty logic never accounts for
it. `sparsePaths` is machine state, one per install, and outside this
repo's control — the repo can only ever carry its own half of this
invariant.

Which file holds that machine state is not a detail, and bug-10 is the
record of getting it wrong twice over.
`~/.claude/plugins/known_marketplaces.json` looks like the control and is
only a cache: Claude Code reconciles it from the `extraKnownMarketplaces`
declaration in `settings.json` on session start, deep-comparing the declared
`source` object against the materialized one and re-running
`git sparse-checkout set --cone -- <declared paths>` in the marketplace
clone on any difference at all. So an `agents` added to the cache by hand
survives until the next session start *and is itself what triggers the
revert* — the edit is the difference the reconciler resolves in the
declaration's favour. An install made in that window carries the agent while
the clone behind it no longer does, which is exactly the state this machine
was found in on 2026-09-02.

The other half of bug-10 was the sync's own blindness to all of it.
`plugin:sync` short-circuited on `hashTree('skills')` alone against a
matching `gitCommitSha`, so an install whose sparse checkout had never
written `agents/` was byte-for-byte indistinguishable from a complete one —
and the short-circuit fired forever, because the one path it measured never
moved. `gitCommitSha` cannot cover for that: it records which commit the
install was cloned from, not which paths were written out of it, and the
same sha legitimately yields an install with `agents/` or without. The sync
now digests every entry of `PUBLISHED_PATHS` on both sides
(`publishedDigests`/`driftedPaths`, exported and unit-tested), relies on
`hashTree`'s existing `''`-for-a-missing-root to make an absent path read as
drift rather than adding a second existence check to keep in sync, names the
paths it compared in both the in-sync and the reinstalling message, and
re-checks the same list after the reinstall. That last check is the
load-bearing one: an install that completes and *still* has nothing at a
published path is the sparse-checkout shortfall by elimination, so it exits
non-zero naming the settings key to edit. A read-only pre-flight warning
reads the declaration it can see and names any published path missing from
it — warn, never refuse, because the declaration legitimately lives at any
settings tier or in `marketplace add --sparse`, and a machine declaring no
`sparsePaths` at all clones the whole repo and is perfectly correct. It runs
before the uninstall so the actionable line is not buried under install
output, and it can never abort in the window between the uninstall and the
install, which is the one that would leave a machine with no plugin.

## `started:` and `phase:` are the lifecycle keys in frontmatter, and neither is a status

The `status:` ban stands (both parsers still throw on it), unaffected by
either of these keys — a second answer to "which directory holds this file"
is the competing source of truth the ban exists to prevent, and neither
lifecycle key answers that question. `started` answers a different one — is
someone on this right now — and an item carrying it is still an open item in
`<section>/open/`. `phase` answers a narrower, shorter-lived question on top
of that: *which* activity currently holds the `started:` marker, `groom` or
`execute`. It has no meaning and no lifespan of its own — it is written
alongside `started:` only when `start` is called with `--as`, and `stop`
always removes it, in the same call that decides what happens to
`started:`. That one-way coupling is deliberate, not an oversight: a `phase`
that could outlive its `started:` as a live marker, or go stale
independently of it, would be a second axis an item's "where is it in its
lifecycle" depended on — exactly the ambiguity the `status:` ban already
exists to close off, reopened one key over. It was a *two*-way coupling —
`phase:` and `started:` removed together, never separately — until Task 7's
`stop --keep-started` deliberately broke the other direction: it removes
`phase:` same as any stop, but leaves `started:` behind, because at that
point `started:` has already stopped being a live marker and become the
archived item's record of when work began — a `phase:` still naming an
activity would misdescribe finished work as ongoing, so it is exactly the
value that must not survive, while `started:` surviving is the whole point.
`stop` never takes an `--as` of its own for this reason — it reads `phase:`
back off the file instead, the one place that can't disagree with itself.
Surfaced raw by the scanner; "in progress" is
`started !== '' && status === 'open'`, decided in the client, because
archiving deliberately keeps the value as history (see below).

`start`/`stop` are still the only two commands that rewrite an existing
item's content — `move` renames and never opens the file — so both must
round-trip unknown keys and the body byte-for-byte, and both stamp
`updated:` while doing it, inside `writeItemFile`, the one function they
both funnel through rather than each writing that line itself (a caller
added later can't forget a convention it never has to know about). `move` is
deliberately excluded from that stamp — opening a file just to change one
line would reintroduce the exact risk the plain `renameSync` exists to
avoid. Every skill path that moves an item calls `stop` immediately
beforehand — `backlog-groom`'s moves (an idea promoted to `done/`, anything
rejected to `out-of-scope/`), `backlog-execute`'s abandonment path, and now
`backlog-execute`'s own successful archive too (see the next paragraph) — so
`updated:` is never more than one function call older than the move that
follows it, for every path there is.

Two skills call `start`/`stop`, holding the marker for different spans, and
`backlog-execute` now calls two different shapes of `stop`. `backlog-groom`
holds the marker for one groom session — `start --as groom` once the item
and the verdict are both confirmed, `stop` again once that verdict's steps
finish, or as soon as the session ends without a verdict at all, so an
abandoned groom never leaves a stamp nothing will clear — billing whatever
elapsed into `groom-elapsed:` every time it does. `backlog-execute` picks an
item up with `start --as execute` and holds the marker until the work is
either parked or archived. Walking away without archiving calls plain
`stop`: it bills the session into `execute-elapsed:` and clears `started:`
along with `phase:`, because nobody is working the item anymore and there is
nothing left to date. Archiving instead calls `stop --keep-started`: it
bills the same way and still drops `phase:`, but leaves `started:` in place,
because a `move ... done` is about to follow and the archived item should
still record *when the work began*, not merely *that* it did — the same
historical value a bare `started:` has always carried for this skill, now
sitting alongside the elapsed total instead of standing in for it. Either
skill can stamp an idea now: the original reasoning for refusing one — "an
idea has nothing to execute" — held for execute but not for groom, since
deciding an idea's verdict is itself the active work the marker exists to
describe. None of this widens who writes the file: `backlog.mjs` is still
the single writer, `start`/`stop` are still the only two commands that touch
an existing item's content, and the round-trip guarantee above covers both
callers identically.

`groom-elapsed:` and `execute-elapsed:` are permanent, accumulating integer
counters — one whole-seconds total per activity, never reset, growing by one
more `stop`'s worth each time that activity picks the item back up again.
`stop` only adds to a bucket when the item has a recognized `phase:`
(nothing to bill against otherwise — a plain `start` with no `--as` leaves
both `started:` and every bucket alone) and when `started:` is the full
second-precision timestamp shape, never the legacy bare date: UTC midnight
is not the hour anyone began work, so treating a bare date as billable would
fabricate up to 24 hours nobody worked — the marker is still cleared, just
never billed. The seconds added are floored at zero, to cover clock skew
between whatever machine wrote `started:` and whatever machine is now
calling `stop`: two machines a few seconds apart must never bill negative
time just because the second one's clock reads slightly behind the first's.
And a bucket that already holds something other than a plain unsigned
integer — a hand-edit, or a value some older, buggier build left behind —
makes `stop` refuse outright rather than reset it to zero: resetting would
silently destroy whatever real total was recorded there, and a refusal at
least leaves the bad value in the file for a human to recover by hand.

`groom-tokens:` and `execute-tokens:` are the token-shaped siblings of those
two, and everything in the paragraph above applies to them unchanged: same
accumulation, same permanence, same DIGITS_ONLY refusal on a corrupt bucket.
There are four counters now, two per activity — elapsed time says how long an
item took, tokens say roughly how much model work it took, and neither implies
the other: a session can idle for an hour or burn a million tokens in ten
minutes. Deliberately ONE gate covers both, not two: the token window *is* the
interval the seconds are computed from, so if that interval is not billable
then neither is the window over it, and `--abandon`, a phase-less `start` and a
legacy bare date each fall out billing nothing without a second rule being
written for them.

The count comes from the calling session's own transcript, which it names
itself: `CLAUDE_CODE_SESSION_ID` is present in the environment of every Bash
tool call and the transcript is flushed mid-session rather than at exit
(measured, on a live session: 317,222 bytes and 14 completed turns on disk
while it was still running), so a `stop` running inside the session it is
measuring can read that session's own history. There is therefore **no hook**
and nothing added to `PUBLISHED_PATHS`. The main transcript is found by
scanning project directories for `<sessionId>.jsonl`, never by deriving the
directory from cwd — the slug rule is undocumented, and a `backlog-execute`
session's cwd is inside a per-item worktree whose slug is not the main tree's
anyway. Subagent turns are NOT in that file: they live in a sibling
`<sessionId>/subagents/agent-*.jsonl` and are summed too, because a run of this
repo's own history spent ~2M tokens on reviewer subagents and a number
excluding them would be worse than no number.

Three rules inside the count, each an answer rather than an omission. **Dedupe
on `requestId`** (falling back to `uuid`): one API turn is written as one record
per content block — thinking, text, tool_use — each repeating the same `usage`
object verbatim, so a naive per-record sum inflates a typical turn 2-3x, and the
inflated number still looks entirely plausible in isolation. Measured, 25 of 28
turns in one transcript were split this way. **Cache reads are excluded** — the
number is `input + cache_creation + output`. Measured on one live session, fresh
89,210 against cache_read 804,246: a raw total is ~90% re-read context floor,
which scales with turn count and prompt size and is close to identical for a
trivial item and a hard one, so it would swamp the signal the number exists to
carry. Cache *creation* stays in as material genuinely pulled into context;
output stays in as the model's own work. (`output_tokens_details.thinking_tokens`
is a subset of `output_tokens` and `usage.iterations[]` is a breakdown of the
top-level fields — adding either double-counts.) **The window's upper bound
covers the whole second the stamp names**, because both stamps truncate to the
second while records carry milliseconds — otherwise the turn that issued the
`stop` call itself, landing at `:50.900Z` against a stamp of `:50Z`, would fall
outside its own window.

Attribution is whole-session-within-the-window, not per-item, and that is
stated rather than fixed because there is no tighter mechanism available:
nothing in a transcript marks a turn as being about item X, so `start`/`stop`
is already the finest bracket that exists. Under `backlog-orchestrate` it is
very nearly exact — each item gets its own headless `backlog-execute` session,
so the window covers that session and nothing else, and that is the consumer
that matters since it is where the expensive items are. For hand grooming in a
shared terminal it is noisy by exactly as much as the unrelated work in the
window. Treat it as a rough complexity signal: right for "which items were
expensive", wrong for anything claiming precision. Do not invent a heuristic to
narrow it.

A count that cannot be attributed at all — no session id in the environment, no
transcript matching it, a file that cannot be read — writes **no key**, not
`0`: `0` claims the work was tiny, which is a different fact. It is never fatal
(the stop still exits 0, and the seconds it did bill are unaffected) but it is
never silent either — one stderr line names what was missing, the same non-fatal
note pattern `registryRoot` uses for a registration it could not make. That note
exists for a specific reason: every measurement behind this feature came from a
headless `sdk-cli` session, and whether an interactive session exports
`CLAUDE_CODE_SESSION_ID` has not been observed, so the first interactive `stop`
either records a number or says out loud why it could not.

The `started:` value is a second-precision UTC timestamp
(`2026-08-28T14:03:07Z`), not a date, because the useful resolution for "is
anyone on this right now" is minutes and hours: a bare date rounded
everything picked up today to `0d`, which is precisely the work the marker
exists to surface, and read as "nothing has happened yet". UTC because the
value is compared against `Date.now()` on whatever machine renders the
board.

Both timestamp shapes are on disk permanently. Every file stamped before
`phase:` and elapsed billing existed carries a bare `YYYY-MM-DD`, and no
command rewrites an existing item's frontmatter on its own initiative — so
this is not a migration window that closes, and a reader that drops the
date-only branch breaks real files. A bare date is aged in DAYS ONLY
(`today`, then `Nd`): UTC midnight is not the hour anyone started work, so
reading `14h` off `2026-08-26` would be inventing it. `elapsedSince` in
`client/src/lib/item-age.ts` is the one implementation of both branches.

## Editing `skills/` changes nothing until commit + push + `plugin:sync`

A plugin install is a copy, not a link: Claude Code loads
`~/.claude/plugins/cache/backlog-manager-marketplace/backlog-manager/<version>/`,
never the working tree. The drift is silent — `started` shipped in `fcd3d16`
and the installed plugin sat on the first commit for weeks. The marketplace
source is the private repo `futin/backlog-manager` over SSH,
sparse-checked-out to `.claude-plugin skills`, which is why an install is
~400KB instead of the ~215MB a `directory` source copied (`node_modules` and
`dist` included — the CLI honours no ignore file; checked against 2.1.246,
and it rejects a `file://` source, so a local-only git source is not on the
table). Git is therefore the publishing boundary: the installer sees pushed
commits and nothing else, so `plugin:sync` refuses a dirty `skills/`, an
unpushed HEAD, or a HEAD behind `origin/main` rather than installing stale
code and reporting success. It never commits or pushes for you. It also
uninstalls and reinstalls rather than calling `claude plugin update`: that
command compares the version in `plugin.json` and stops at "already at the
latest version" however far the commit behind it has moved, and the cache
directory is keyed by version, so the alternative would be a patch bump —
another commit, another push — on every skills edit. A reinstall from a
sparse source is cheap enough that the bump buys nothing. It no-ops when
the installed copy already matches HEAD, verifies the landed `skills/` by
hash, and prunes older version copies — skipping any marked `.in_use`,
which a running session still has open. New skills load on the next Claude
Code restart, not in the session that ran the sync.

## Loopback bind is the access control (except where noted)

Nothing in this stack has auth in front of it — the item-body route reads
every registered project's backlog files straight off disk — so loopback is
the access control. `BM_BIND` is the single knob for the bind (`main.ts` and
`vite.config.ts` read the same variable); `docker-compose.yml` sets it to
`0.0.0.0` in both services because there the loopback *publish* is the
boundary and a container-loopback bind would just hide the port. Reach it
from another device with your own `tailscale serve` in front of the loopback
port, which is also what makes `allowedHosts: ['.ts.net']` in
`vite.config.ts` meaningful — that list is never consulted for a bare IP, so
it protects nothing on a wildcard bind. With `BM_AGENTS` on, that bind is no
longer standing in front of a read surface alone: it also fronts a POST that
spawns a Claude Code session with file-write permission in another repo.
That is a boundary a browser inside the loopback does not respect at all,
which is exactly why the origin and content-type guard on those two routes
exists — the bind and the guard cover different attackers, and neither
substitutes for the other.

## The served build carries a CSP; dev does not

`server/src/security.ts` sets the header from Nest, so it rides on
`client/dist` and on `/api` alike. It is deliberately not a `<meta>` tag in
`client/index.html`: that would apply in dev too, where Vite injects an
inline React-refresh preamble a strict `script-src` would block. Dev binds
loopback only, so the build is where the policy earns its keep. `script-src`
carries the sha256 of the pre-paint theme script instead of
`'unsafe-inline'` — edit that script and `test/csp.test.ts` goes red until
`THEME_SCRIPT_SHA256` follows.

## Dispatch derives the action; it never accepts one

`shared/agent.ts` is the single derivation (`deriveAction`), imported by the
board to label a button and by the server to validate a request — one
implementation, so a button can never promise what the API refuses.
`POST /api/agents/dispatch` re-scans the item file and 409s when the
request's action disagrees, which is the groomed invariant enforced on the
only side that can read the file. The prompt is the one field whose
client-supplied content is taken outright — `action` is checked against the
file rather than trusted, `permissionMode` is clamped to the dashboard's
ceiling, and `model`/`effort` go through `pickFrom` against the mirrored
`MODELS`/`EFFORTS` lists — so editing the prompt in the launch sheet is the
actual point of the sheet. Those last two drop rather than clamp or reject:
there is no ladder to clamp along and nothing in the item file to check
against, and `undefined` is what makes `JSON.stringify` omit the key, which
is what makes the dashboard omit the flag — so a name this build has not
heard of costs that flag, never the launch, which is the failure mode a
duplicated list has to survive. Note the controller rebuilds the dispatch
body field by field, so a new field reaches the service only when it is
added there too.

## The orchestrate spawn prompt is composed server-side

`ORCHESTRATE_PROMPT` (`agents.service.ts`) is the literal string
`/backlog-orchestrate` — `backlog-orchestrate`'s own `SKILL.md` declares
that exact phrase as its `trigger:`, so the constant is that declaration,
not an invention on the server side. `dispatch`'s prompt varies by design,
because *what to say* about a derived action (groom vs. execute) is a
client-editable default the launch sheet composes and a human reader may
reword before sending; `orchestrate` has no equivalent decision to leave
open — it always means the same thing, "hand this project's whole groomed
queue to the skill," so there is nothing legitimate for a caller to vary.
`AgentOrchestrateRequest` (the body shape `POST /api/agents/orchestrate`
accepts) has no `prompt` field to begin with, and `AgentsController`'s
handler rebuilds the service call field by field from `project`, `model`,
`effort`, `permissionMode` and `ids` alone — so a `prompt` sent in the
request body is not validated and rejected, it is simply never read. That is
the same mechanism `dispatch` already relies on for every field outside its
own request type, applied here to the one field that would otherwise be the
sole way an attacker-controlled cross-origin request could make an
unattended, headless session do anything at all.

`ids` is the one thing a caller can put into that string, and it is not an
exception to the rule above so much as the clearest statement of it. The
board's Orchestrate sheet can narrow a run to a subset of the queue, which
means the spawned session has to be told `/backlog-orchestrate task-3 bug-7`
rather than the bare trigger — `--ids` is a flag `orchestrate.mjs`'s own
`init` and `plan` have always taken, and `SKILL.md` documents the trigger as
`/backlog-orchestrate [ids…] [--max N]`. What makes that safe is that the
server never *accepts* prompt text, it *composes* the prompt out of the
constant plus values that have passed two independent checks (`resolveIds`,
`agents.service.ts`):

1. **Shape** — `isItemId` (`shared/agent.ts`), the same
   `^[a-z]+-\d+$` `backlog.mjs`'s own `ID_SHAPE` enforces. What survives is
   a bare identifier: no whitespace, no path separator, no shell
   metacharacter, and no newline to split the one-line prompt with.
2. **Membership** — the id must name an *open bug or task* in *the project
   being orchestrated*, scanned per request. Scoped to that one project
   deliberately, unlike `findItem`'s registry-wide walk: `bug-2` exists in
   most stores, and accepting another project's id would hand `--ids` a
   value that `init` then exits `1` on, inside a headless session nobody is
   watching.

Shape alone is far too weak (`bug-999` passes it); membership alone would be
running a directory scan over attacker-shaped strings. Together they mean
the only thing a caller can put in that prompt is the id of one of this
project's real, runnable items. Malformed input is a 400 and a file
disagreement is a 409, matching the split `dispatch` already makes — and the
409s here are deliberately uncoded, because `RUN_IN_PROGRESS_CODE` is the
one 409 this endpoint has that a machine needs to tell apart.

Two smaller rules ride along, both about the difference between *absent* and
*empty*. An absent `ids` means "the whole queue" and produces the bare
constant. An explicitly empty `ids` is a 400, never silently read as
"everything" — that is `parseIdsArg`'s own distinction in `orchestrate.mjs`
(`--ids ''` must not mean "give me everything") enforced one layer up, at
the only place a browser can reach. And the sheet sends `ids` **only when
the selection is a strict subset**: a full explicit list is a different
instruction from no list at all, because it freezes the run to the queue as
it stood when the sheet opened, dropping anything groomed and committed
while the reader was looking at it.

## The browser never talks to the dashboard

`connect-src 'self'` forbids it and the bearer token must not be in a page,
so every call goes board → this API → dashboard. `BM_AGENTS_URL` is env-only
and never client-supplied: there is deliberately no request shape in which a
browser names the host this server will call. `BM_AGENTS` defaults to off,
so an unconfigured install makes no outbound request at all.

## A project the dashboard cannot see cannot be dispatched to

Its `POST /api/spawn` takes a `dirName` resolved against projects active
inside its `LOOKBACK_HOURS` (24 by default), so a quiet repo has no key to
send. Accepted, not worked around: the alternative is teaching that app to
take an absolute path, which widens the widest write surface it has. This is
one of the three blocks that leave a control on screen (the other two are a
local skill session's `started:` stamp and a live orchestrator run's claim —
see the `dispatchGate` section below): the button's
own `title` and its visually-hidden `aria-describedby` span carry the per-item
reason (it names the path, and nothing else in the UI does), while Settings
lists the host-level setup — including the two fixes for this one, a session in
that repo or a higher `LOOKBACK_HOURS`. That reason states the missing path as
fact and the lookback only as a likelihood ("the dashboard does not list X —
most likely no Claude session there…"), because every reader of the string is
one step removed from the dashboard's own answer: the server holds a project
map for up to `PROJECT_TTL_MS`, and a browser tab holds a copy of that. It
used to assert the lookback flatly, which is what made a stale block
*confidently wrong* rather than merely late — it sent people to open a session
in a repo that already had one (bug-13, below). Environment-level blocks render no
button at all; see that same section below. Never derive a `dirName` from
a path to route around this. The membership check behind it
(`status.projectPaths.includes(item.projectPath)`, in `dispatchGate`,
`shared/agent.ts`) is a raw string compare, not a realpath one, even though
`agents.service.ts` already calls `realpathSync` elsewhere for its own item
lookup and could afford one here too: `dispatchGate` is one implementation
the board also runs in a browser, which has no filesystem to resolve a
symlink with, so the server side stays just as literal rather than let the
two sides risk giving different answers. Known consequence: a registered
project whose path reaches its git root through a symlink can show a
disabled button even with a live session inside `LOOKBACK_HOURS`, if the
dashboard's own recorded path and the registry's do not match byte-for-byte.

## Environment-level blocks hide the dispatch control; per-item ones disable it

`dispatchGate` (`shared/agent.ts`) answers with
`hidden` / `disabled` / `enabled`, and `dispatchBlock` is the flattened
string form of the same ladder for the two callers that only refuse (the
launch sheet's re-check and the server's). Dispatch off, dashboard
unreachable, no `CLAUDE_BIN`, remote answers off — none of those is about
any one card, all four are true of every card at once, and none is fixable
from the board, so they render no button. That is what makes the promise in
the spec and `.env.example` — with `BM_AGENTS` off the board "renders
exactly as it does today" and "shows no dispatch buttons" — literally true;
do not "improve" it into a disabled button on forty cards.

The per-item blocks are the opposite case and keep their button. There are
**three** of them, not one, and only the first is anything `dispatchGate`
itself can answer:

- **The dashboard cannot see this item's project** — `dispatchGate`'s own fifth
  line, the section above.
- **A local skill session already holds this item** — `progressBlock`
  (`client/src/lib/item-progress.ts`), and the only one of the three derived
  from the item file itself. It is the exact mirror of the block below it:
  `started:` has one writer (`backlog.mjs start`) and one clearer (`stop`), so
  a session grooming or executing an item states that in the frontmatter the
  board is already reading — `isInProgress` had been deriving it for the card's
  amber bar since before dispatch existed, and nothing ever wired that
  predicate into the dispatch path. It blocks on ANY stamp, fresh or stale,
  matching `start`'s own rule that any stamp refuses: a stamp nobody is behind
  is a lie the board must not paper over, and `stop` is the one-command fix for
  it. What stops an ancient stamp from blocking forever is `isInProgress`'s
  `status === 'open'` half — `move` never rewrites content, so an archived
  item's stamp is history rather than a claim. It lives in `item-progress.ts`
  and not in `shared/agent.ts` beside `runClaimBlock`, breaking that file's
  otherwise complete ownership of the block vocabulary on purpose: it is built
  from `isInProgress` and `progressLabel`, which are both already there,
  `shared/` must not import from `client/`, and hoisting the pair over would be
  a move made for a block the server has no use for. Client-only is the whole
  decision, not an omission — the board is the only surface that can
  double-dispatch, and the server's dispatch re-scan is unchanged. Unlike the
  run claim there is nothing here for the server to catch late: the skills
  already refuse (`start` will not stamp a file that carries a stamp), so what
  a second spawn cost was never a corrupted file but a wasted session and a
  refusal the user had to go and interpret — `backlog-groom` opening the whole
  "whose marker is this" conversation about a marker its own board set ninety
  seconds earlier.
- **An orchestrator run has already claimed this item** — `runClaimBlock`
  (`shared/agent.ts`), which reads the run payload rather than the item. It has
  to: a run works each item inside its own git worktree and nothing reaches
  `main` until the item merges, so while a run holds `task-7` at `reviewing` the
  `task-7` file `/api/items` scans on `main` looks untouched — no `started:`, no
  `phase:`, nothing `isInProgress` could key off. The item is not lying; it is
  telling the truth about `main`. Claimed means a stage in
  `RUN_CLAIMED_STAGES` (`shared/types.ts`) on a run that is *fresh*: the eight
  non-terminal stages, `pending` and `preflight` included, because a pending
  item is already the run's and a manual session that grooms or archives it
  first leaves the run dispatching into an item that moved under it. The seven
  exits (`merged`, `branched`, `failed`, `skipped`, `needs-answers`,
  `ungroomed`, `parked`)
  are out — the run is finished with the item, and a human picking it up by
  hand is the intended next move, `parked` most of all. That list is
  deliberately NOT `ACTIVE_RUN_STAGES` (client `ItemCard.tsx`), which answers
  "does this card show a live stage badge" and correctly excludes
  `pending`/`preflight`; the two overlap by six members and must not be
  unified. This block is checked on the board and again in `dispatch()`, the
  second being the one that holds: the launch sheet fetches its plan once on
  mount, so a sheet left open while a run starts still shows an enabled launch
  button, and only the server sees the run as it is at click time.

`DispatchButton` reads all four in one order — environment-hidden, then
project visibility, then the in-progress stamp, then the run claim — most
fundamental first, so the reason on screen names the thing to fix rather than a
symptom of it. With dispatch off or the project invisible there is nothing
worth saying about either kind of session that might hold the item. The last
two rungs are in that order for the same reason applied one level down: the
`started:` stamp is on the very copy of the item this board is rendering, while
a run claim is a fact about another worktree that the next poll can change, so
the file wins. They coexist only pathologically — a run stamps `started:` on
its own worktree's copy, which is exactly why `runClaimBlock` has to exist, so
the registry's copy of a claimed item normally carries no stamp at all — but a
reader who has both is better served by the one they can go and look at.

This was bug-4: the run claim existed nowhere in the ladder, so a card an
unattended run already owned kept a live dispatch tab, and clicking it spawned
a second session against an item held in another worktree on `backlog/<id>`.

The in-progress block was bug-12, the same shape one rung down and with the
data in the opposite place: the card rendered its amber in-progress bar and an
enabled dispatch button side by side, one telling the reader a session held
this item and the other offering to start a second one against it.

**One of the three lets the click through anyway, and only one: a
project-visibility block re-asks the status instead of swallowing the click**
(bug-13). `useAgents` refetches on mount and window focus alone, deliberately —
what changes the answer happens outside the tab and you come back to the tab
afterwards — and that reasoning simply has no purchase on a window that never
loses focus (a board on a second monitor, or the only window in use). The
staleness that follows was argued to be bounded: `PROJECT_TTL_MS`'s own comment
said a minute of it "costs a disabled button that would have worked, which the
sheet's own re-check then corrects". True in exactly one direction. A stale
*enable* is corrected by the sheet, because clicking opens it and `plan()`
re-derives the block server-side; a stale *disable* is not, because the sheet
that would correct it is behind the control the stale answer just made inert.
The self-correcting path was unreachable from the state that needed it, so the
board sat on a confidently actionable message that was no longer true with
nothing in the UI able to clear it.

So the click asks. `DispatchButton` takes `reverify` — the board's own
`useAgents().reload`, which now RESOLVES to the status it fetched rather than
only setting state (the setState lands a render too late for the handler that
provoked it) — calls it once, marks itself `aria-busy` while it waits, and
opens the sheet only if `dispatchGate` reads `enabled` against the *fresh*
answer. Worst case is one wasted request and a button that stays disabled,
with the reader now able to see it was actually asked; the server is
authoritative either way and `plan()` re-checks on open regardless. Note the
one bound that remains: the refetch can still be answered from the server's own
`PROJECT_TTL_MS` map, so a re-ask inside that minute can legitimately come back
with the same list — the fix removes the *unrecoverable* state, not the cache.

The scope of that exception is the fix, not a gap in it. The run claim keeps
swallowing the click: `useOrchestratorRuns` polls every 5s while any run is
fresh, so it is never stale in this way, and a claimed item genuinely must not
be hand-dispatched. The in-progress stamp keeps swallowing it too: it is
derived from the very item file the board is rendering, so no status refetch
could move it. And a button blocked by project visibility *and* one of those
two behaves as that block's case — clearing the visibility half would leave
the click refused anyway, so there is nothing worth asking. Two alternatives
were rejected on the way: a polling interval on `useAgents` asks the same
question on a timer for every reader whether or not anyone is looking at a
blocked button, which is what the mount+focus cadence was chosen over; and a
`visibilitychange` listener narrows the window without closing it, since the
failing case has the tab visible and the window focused the whole time.

## One run per project, checked twice

`orchestrate.mjs init` is the authoritative lock: it refuses outright — exit
code 4, nothing written — whenever the project's existing run file still
says `status: "running"`, whether that heartbeat is fresh or stale. A fresh
one is the easy case, a second process about to stomp on a live run's
state. A stale one is deliberately refused too, rather than treated as
free: `status: "running"` with an old `updatedAt` is not an idle lock, it is
the last known state of a run that crashed mid-item, and silently starting
over on top of it would bury that crash without a trace — an orphaned
worktree and branch leaking forever, a dead `started:`/`phase:` marker
billing wall-clock time nobody notices. Recovering it is deliberately not
plain `init`'s job; the refusal names `--resume` and `--abort` by name so
the person looking at it is never left to guess. `POST /api/agents/orchestrate`
cannot rely on that check alone, because a click on the board's own control
reaches the dashboard's spawn endpoint directly — the one path into a new
run that never calls `orchestrate.mjs init` at all before something starts.
So `AgentsService.orchestrate()` re-reads the orchestrator's own run list
and checks the same project for a run with `fresh === true` (the
`RUN_STALE_MS` freshness check, not the skill's broader fresh-or-stale
one — a stale run here is left for the spawned session's own `init` to
catch and diagnose properly, since only the skill side knows how to offer
`--resume`/`--abort`) before it will spawn anything. This is
belt-and-suspenders in the same shape as the registry's single-writer rule: the
check that truly matters lives with the writer, and every other path
capable of triggering one re-checks it rather than trusting that callers
will always go through that writer. This particular 409 is also the only
one `orchestrate()` throws that carries a `code`
(`RUN_IN_PROGRESS_CODE`, `shared/types.ts`) — a prior incident had a client
guess which 409 it received by matching a substring of the `error` prose,
which broke the moment the wording changed, so the lock case alone gets a
stable, machine-readable answer and the other 409s this endpoint can throw
deliberately do not, because nothing about them needs to be told apart.

## The two agents POSTs are guarded by content-type and origin

(`server/src/agents/origin.guard.ts`) — this is the one place in the app
where loopback is NOT the access control. Nest registers
`express.urlencoded` on every app it builds, and
`application/x-www-form-urlencoded` is a content type a cross-origin HTML
form posts with no CORS preflight — so before this guard, any page in the
developer's browser could auto-submit a hidden form at
`/api/agents/dispatch` and spawn a session with an attacker-written prompt.
The browser is already inside the loopback boundary; a bind cannot help.
Both halves are load-bearing: a non-`application/json` content type is
refused (which forces a preflight there is deliberately no `enableCors` to
answer), and a present `Origin` that is not this request's own host is
refused (which is what closes `Origin: null` from a sandboxed iframe).
Absent `Origin` stays allowed — curl and every server-side test send none.
`GET /api/agents/status` is deliberately outside it, like every other GET
here. Known consequence: a TLS-terminating proxy in front of this that
rewrites `Host` without rewriting `Origin` will 403 — the guard compares
host and port only, not the scheme, precisely so a `tailscale serve` that
preserves `Host` keeps working.

## Launch sheet model/effort pickers seed from Settings, never the last launch

`dispatchDefaultModel` / `dispatchDefaultEffort`
(`client/src/lib/settings.ts`, mirroring the dashboard's own
`spawnDefaultModel` / `spawnDefaultEffort`) are per-device like every other
key there, default to `''` — no flag, the CLI decides — and are clamped
against the same `MODELS`/`EFFORTS` the sheet renders, so a stored name can
never be one the selects cannot show. Remembering the *last pick* stays
rejected: a sticky `max` from last week quietly spending on a trivial groom
is the failure a per-launch control exists to prevent, and a default you set
once in a row you can go and read is the opposite arrangement. Permission
mode deliberately has no stored default — it comes from the server's
`plan.defaultMode` and is clamped to the host ceiling, and a remembered mode
would fight that ladder. That server-side default is `auto`, because a
dispatched session runs unattended: nobody is necessarily at the terminal a
permission prompt would appear on. What a lower rung actually costs is worth
stating precisely, because the earlier wording here ("a session that stops on
its first unapprovable tool call and silently does nothing") was half right,
and half right is worse than wrong. Measured against CLI 2.1.250: it does
*not* stop and it does *not* do nothing. A refused call returns an ordinary
`tool_result` with `is_error: true`, the session reads it and **improvises
around the refusal**, and the run still exits `0` reporting
`subtype: "success"`. So the hazard a too-low rung buys is not a wedged
session anyone would notice — it is a session that quietly reached its
conclusion by some other route, with the refusal recorded nowhere but the
transcript's `permission_denials` array. That is the failure mode the
ladder's default sits where it does to avoid. `auto` is still not the top
rung — `bypassPermissions` stays a per-launch choice, since asking for the
most a host allows by default is how a convenience becomes an incident — and
the ceiling clamps `auto` down on a dashboard that caps lower, so this never
widens a stricter host.

`backlog-orchestrate` reaches the same conclusion from the other side. It
used to hard-code `--dangerously-skip-permissions` on its headless dispatch,
justified by a premise the paragraph above disproves — that a prompt inside a
headless session is a hang. It now dispatches under `--permission-mode auto`
like everything else here, and because `auto` can genuinely refuse a call, it
reads `permission_denials` off the transcript's last `result` event before it
judges an item clean (`orchestrate.mjs`'s `readPermissionDenials`, surfaced
as `orchestrate.mjs denials`). The mode each session ran under is recorded on
its queue item (`RunQueueItem.permissionMode`), so a denial found in a log has
the mode that produced it sitting next to it.

## `linkBase` is per-device and becomes an href

`clampSettings` routes it through `clampOrigin`, which parses it as a URL —
the browser's own parser, not a regex — and rejects any scheme but
`http(s)`. It is the one settings key a hand-edited localStorage value could
turn into script execution.

## Queue wait is not work

`itemDurationMs` (`client/src/lib/run-time.ts`) is the one implementation of
"how long did this item take." It measures from an item's first
non-`pending` `stageAt` arrival — `preflight` counts, because the gate check
is the orchestrator doing work on this item; only `pending`, the interval
where nothing is happening to the item at all, is dropped — to its terminal
stamp, or to `now` while the item is still moving. Every surface that prints
that reading calls it rather than deriving its own: the run drawer's row and
the Runs section's detail-pane row, through the shared `RowTime`
(`client/src/components/board/RunRowTime.tsx`), and `aggregateRuns`'
`avgItemWorkMs` (`client/src/lib/run-stats.ts`), which averages it over
every merged item. Nothing else in this codebase reads it.

`run-stats.ts` used to carry a second implementation of the same question,
answering it by spanning an item's literal first recorded stamp to its
last — `pending` included. The two silently disagreed on a real run
(`run-20260901-112815`): bug-7 read as 161 minutes of "how long did this
item take" under that first-to-last reading and 25 minutes under
`itemDurationMs` — the other 136 minutes were the four items ahead of it in
the queue being worked while bug-7 waited its turn, not anything that
happened to bug-7 itself. A queue worked one item at a time will always
produce this gap for whichever item sits further back in it; folding queue
wait back into a duration reading is exactly the bug this invariant exists
to keep from recurring. The excluded interval is not thrown away —
`itemQueueWaitMs` (same file) gives it its own reading, printed by the Runs
pane as context beside the head time — but it is never added back into any
"how long did this take" total anywhere in this codebase.

Machine time makes the identical exclusion one level up, for the identical
reason. `runStageTotals` (`client/src/lib/run-stats.ts`) — the "where did
the time go" rollup behind `StageBars` — sums every item's per-stage spans
against `MACHINE_STAGES`, the closed list of the seven stages that are the
orchestrator actually working, and `pending` is not on it: summing every
item's queue wait into a run's own "machine time" would report however many
run-lengths of pure nothing on top of whatever the run actually did — the
run-level version of the same mistake `itemDurationMs` exists to prevent at
the item level.

A new surface that needs to answer "how long did this item take" imports
`itemDurationMs` and reads its result rather than subtracting `stageAt`
stamps itself. That is not a style preference: it is the only way the
drawer, the Runs pane, and any surface built after them are guaranteed to
agree with each other, the same guarantee `RowTime`'s move out of the run
drawer and into a shared component exists to make structural rather than
coincidental.
