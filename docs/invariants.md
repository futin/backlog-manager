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
orchestrator before its child process has even changed directory. The
failure mode if that contract were ever broken is silent, not loud: a linked
worktree carries its own `.git` (a file, not a directory, pointing at the
shared gitdir), so `existsSync` finds it immediately and happily resolves
the WORKTREE's own path as "the project" instead of erroring — the run
would then be keyed under `encodeURIComponent(<worktree path>)`, a directory
nobody else ever reads, since the server and every other command key by the
registered project's own path. The run would not crash; it would just
appear to vanish, which is far harder to notice and debug than a loud "no
`.git` found" refusal. This is exactly why the skill must always invoke
`orchestrate.mjs` from the project root and never from inside a worktree it
created — the per-item worktree and branch a command needs are passed as
explicit values instead (`stage --worktree <path> --branch <name>`,
`verify --cwd <dir>`), never implied by cwd.

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
recorded as `sparsePaths` in that machine's `known_marketplaces.json`.
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
the one block that leaves a control on screen: the button's own `title` and
its visually-hidden `aria-describedby` span carry the per-item reason (it
names the path, and nothing else in the UI does), while Settings lists the
host-level setup — including the two fixes for this one, a session in that
repo or a higher `LOOKBACK_HOURS`. Environment-level blocks render no button
at all; see the `dispatchGate` section below. Never derive a `dirName` from
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

## Environment-level blocks hide the dispatch control; per-item disables it

`dispatchGate` (`shared/agent.ts`) answers with
`hidden` / `disabled` / `enabled`, and `dispatchBlock` is the flattened
string form of the same ladder for the two callers that only refuse (the
launch sheet's re-check and the server's). Dispatch off, dashboard
unreachable, no `CLAUDE_BIN`, remote answers off — none of those is about
any one card, all four are true of every card at once, and none is fixable
from the board, so they render no button. That is what makes the promise in
the spec and `.env.example` — with `BM_AGENTS` off the board "renders
exactly as it does today" and "shows no dispatch buttons" — literally true;
do not "improve" it into a disabled button on forty cards. The
project-visibility block is the opposite case and keeps its button.

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
