---
id: bug-49
title: A session killed mid-item holds its claim for the full stale window, though the machine knows the process is gone
created: 2026-09-22
tags: tracker, claim
updated: 2026-09-23T07:55:24Z
groom-elapsed: 251
groom-tokens: 72546
started: 2026-09-23T07:32:32Z
execute-elapsed: 1372
execute-tokens: 225495
---

## Symptom

A session that is stopped by hand while it holds a tracker item's claim releases nothing. The claim comment keeps no `released` block, the issue keeps its
`in-progress` label, and every machine reads the item as in progress for a full `CLAIM_STALE_MS` (15 minutes) after the process is already dead. Nothing on
any surface says the holder is gone, and nothing clears it on its own.

This is the state bug-48 described and half-solved: it added the host clause AND `backlog.mjs abort <id>`, the one-word command that invokes it, so a person
at the holding machine can clear the claim in a second. What is still missing is anybody to run it WITHOUT a person: nothing notices the process died, so an
unattended run on another machine waits out the full window, and a person who walked away leaves the item locked until they come back.

The machine already has the evidence. On the run below the dashboard reported `runningClaudeProcs: 0` within seconds of the stop, while the same session still
rendered as `working` from its last transcript line and the claim on the issue stayed live for another eight minutes until it was released by hand.

## Repro

Observed 2026-09-22 on `futin/guide-manager#5`, with two machines racing the claim (Mac `facc726a`, Linux `77a705a3`):

1. Start `/backlog-execute` on a tracker project's item from machine A; let it win the claim. Here: Linux `77a705a3` took comment `5776031009` at 11:56:39Z,
   host `futin_ubuntu@<host>`.
2. Stop that session from the dashboard (or kill the process) while the item is mid-execute — before any terminal stage.
3. Read the claim from any machine: `GET /api/items/claim?project=<path>&id=gh:<owner>/<repo>#<n>`.

Observed: the record still carries `heartbeat: 2026-09-22T11:56:39.324Z` and no `released` key at 11:59:21Z, nearly three minutes after the process exited.
The issue still carries `in-progress`. `GET /api/sessions` on that machine's dashboard reports `runningClaudeProcs: 0` for the same period, and the session
row is still labelled `working`.

Expected: within one dashboard poll of the process disappearing, the claim carries `released: { reason: "aborted", ... }`, the `in-progress` label comes off,
and the item is claimable again — without the 15-minute wait and without a person composing a release by hand.

Cleared by hand with `POST /api/items/release` against the HOLDING machine's own API (`host: futin_ubuntu@<host>`), which is bug-48's clause working as
designed; the claim then showed `released: { at: 2026-09-22T12:00:23.536Z, reason: "aborted: session 77a705a3 stopped by the user mid-item" }`.

## Affects

- `shared/types.ts:2004` — `ItemReleaseRequest.host`, whose own doc states this case: a hand-run session killed mid-item "passes through no terminal stage, so
  it releases nothing", and "the item reads as in progress on every machine for a full `CLAIM_STALE_MS` with no command anywhere to clear it".
- `server/src/items/sources/github.source.ts:569` — `GithubSource.release`, and its four-clause rule (holder / run / host / anyone-once-dead). The host clause
  is the one a fix would call.
- `server/src/items/items-write.controller.ts:153` — `POST /api/items/release`, the route such a caller would use.
- `shared/types.ts` — `CLAIM_STALE_MS`, the 15-minute window this bug is the cost of.
- `server/src/tracker/claim.ts:183` — `isLive`, which is heartbeat-only by design and cannot itself know a process died.

## Cause

Three things, and the first one is a defect in bug-48's own repair that has to be fixed before anything automatic can be built on it.

**1. `abort`'s proof of death can never fire for the case it was written for.** `holdingSessionEvidence` (`skills/backlog/tools/backlog.mjs:1590`) calls
the holder alive if any transcript of its session has an mtime at or after the claim's `heartbeat`. But the `start`/`heartbeat` that stamped the beat is
itself a `Bash` tool call inside that session, and the session appends the call's `tool_result` to its transcript AFTER the server stamps the beat — so a
session killed at any point after its last heartbeat returned always has a transcript newer than the beat, and `abort` refuses it as "still writing here".
Measured on the repro session: `77a705a3-….jsonl` on this machine has mtime `2026-09-22T11:57:18.561Z` against the claim's heartbeat
`2026-09-22T11:56:39.324Z` (the `tool_result` lines run to 11:56:55Z, and the shutdown bookkeeping lines `last-prompt`/`cost-state` land at the stop).
`abort 5` on that claim would have refused, which is why the repro was cleared with a raw `POST /api/items/release` rather than the verb bug-48 added. The
unit tests stayed green because they fixture a transcript mtime by hand and never model a session whose last act was the beat itself. Transcript mtime
answers "did this session ever write after the beat", which every session did; it cannot answer "is the process still there".

**2. The evidence that CAN answer it exists, and nothing reads it.** Claude Code keeps its own process registry at `<configDir>/sessions/<pid>.json`:
`{ pid, sessionId, procStart, cwd, kind, status, … }`, one file per running `claude` process, headless `-p` sessions included. Verified on this machine
2026-09-23:
- the file is written at process start and stays for the whole life of the process, busy or idle — so a session quiet between long tool calls is present;
- it is REMOVED on a graceful exit: the repro session `77a705a3` (stopped from the dashboard) has no file;
- it is LEFT BEHIND by a hard kill: `1726359.json` names session `6bb566f5` and `process.kill(1726359, 0)` answers `ESRCH`;
- `procStart` equals field 22 of `/proc/<pid>/stat` (checked on the live `1895628`: `25913776` both), so a reused pid is distinguishable from the original.

So on the holding machine "no registry file names the session" proves a graceful exit, and "a file names it but its pid is dead or its `procStart`
differs" proves a hard kill. The dashboard's own liveness signals are weaker for this: `runningClaudeProcs` is a machine-wide count, `liveCwds` is per
directory (two sessions in one repo are indistinguishable), and `liveSessionIds` only sees ids that appear in argv (`--session-id`/`--resume`), so a
plainly-launched terminal session would read as dead.

**3. Nothing on the holding machine looks.** The one clause that may release a live claim for a gone holder is bug-48's `sameHost`
(`server/src/items/sources/github.source.ts:597`), and its only caller is a person typing `abort`. No periodic process on the host asks the question. The
obvious owner is this server — it already polls every connected repo on a timer and caches every claim comment (`poller.service.ts`, `claimsFor`) — but
it runs in the compose stack under **Docker Desktop**, whose containers share neither the WSL distro's pid namespace nor its `~/.claude`. So the server can
be taught to read the registry FILES (a read-only mount), but must never be taught to test a pid: inside the container `process.kill(pid, 0)` answers
`ESRCH` for every host pid, which would read every live session as dead.

## Fix

Two parts, in this order: part A is a standalone correction to bug-48 and is what part B's reasoning rests on. No `runner-fix:` — nothing here touches
`backlog-orchestrate`'s SKILL.md or CLI, the reviewer agent, or `server/src/agents/`.

Assumptions decided without the user (no question channel in this session): the sweeper lives in this server rather than in the dashboard, which knows
nothing about claims; the hard-kill case stays on the fifteen-minute window when the server runs in Docker, rather than widening the container to the host
pid namespace, which Docker Desktop cannot give it anyway; and run-owned claims are out of the sweep.

**A. Replace the transcript-mtime evidence with the process registry, in `backlog.mjs`.**

- `holdingSessionEvidence(session, heartbeatISO, env)` becomes a registry reader (the heartbeat argument goes). Scan `<configDir>/sessions/*.json` —
  `<configDir>` derived exactly as `claudeProjectsRoot` derives it, `CLAUDE_CONFIG_DIR` first. A file is evidence of life when its `sessionId` equals the
  holder's, `process.kill(pid, 0)` succeeds or throws `EPERM`, and — where `/proc/<pid>/stat` is readable — its field 22 equals the file's `procStart`.
  Where `/proc` is absent (macOS) the pid test stands alone; a reused pid then reads as alive, which is the safe direction.
- Fail CLOSED on a registry this build does not understand, because a misread there turns every live neighbour into a dead one. Three states, not two:
  `alive` (evidence found), `gone` (registry read, nothing names the session), `unknown`. It is `unknown` when the directory is missing or unreadable, when
  any `*.json` in it lacks a string `sessionId` or a numeric `pid`, or — when the aborting process has a `CLAUDE_CODE_SESSION_ID` — when the registry has no
  live entry for the aborting session itself. That last one is the self-check: a session that cannot find itself is reading a registry whose shape changed.
- `abort` refuses on `alive` (the existing refusal, reworded to name the registry file and pid instead of a transcript) and on `unknown` (new refusal:
  cannot tell whether the session is gone, wait out the 15 min window). Only `gone` releases. Every other refusal and the request body are unchanged.
- A claim whose `session` is the `<user>@<host>` fallback (no `CLAUDE_CODE_SESSION_ID`) has no registry entry by construction; keep bug-48's reading that
  the person at that terminal is the one running `abort`, so it releases — but it is excluded from part B, see below.
- Update the prose that describes the old check: `skills/backlog-groom/SKILL.md:99`, `skills/backlog-execute/SKILL.md:179-180`,
  `.claude/rules/tracker.md:21`, and `docs/subsystems/invariants.md:2907` ("finds no transcript … whose mtime is at or after" becomes the registry rule).

Test cases for A (`skills/backlog/tools/backlog.test.mjs`, the bug-48 `abort` block at ~4294; the two transcript-mtime cases are replaced, not kept):
- registry dir with no file naming the holder, aborting session has its own live entry (fixture it with `pid: process.pid` and the test process's real
  `procStart` or no `/proc` check) → one `POST release`, `reason: 'aborted'`, exit 0;
- a file naming the holder with `pid: process.pid` → exit 1, no request, message names the file;
- a file naming the holder with a pid that is not running (spawn and reap a child, use its pid) → releases;
- a file naming the holder with `pid: process.pid` but a `procStart` that differs from `/proc/self/stat` field 22 (Linux only; skip elsewhere) → releases;
- registry directory absent → exit 1, no request, "cannot tell";
- a `*.json` without `sessionId` → exit 1, no request;
- `CLAUDE_CODE_SESSION_ID` set but no entry for it → exit 1, no request;
- a transcript for the holder with mtime AFTER the heartbeat and no registry entry → releases (the regression case: this is the repro, and today it refuses).
The host, no-host, released and dead-claim cases are unchanged and must stay green.

**B. A claim sweeper in this server, for graceful exits.**

A new service in `server/src/items/` (it calls `GithubSource.release`, which lives there; the poller must not import it back) that runs after each
successful per-repo sync of `TrackerPoller` — a callback the poller exposes, so the sweeper inherits the "armed only while something is connected"
behaviour instead of owning a second timer. For each cached claim in the synced repo it releases the claim when ALL of these hold:
- the claim is live (`isLive`) and carries no `run` — a run's claim has its own recovery path (watchdog resume, `orchestrate.mjs abort`), and releasing it
  between a driver crash and its resume would hand the item to somebody else mid-run;
- `session` is shaped like a Claude Code session id (a UUID), never the `<user>@<host>` fallback, which has no registry entry and would always read gone;
- `host` is one this server has been told is its own: an in-memory set of the `host` values carried by `POST /api/items/claim` requests this process has
  received (the API is loopback-bound, so those callers are on this machine). In memory only, never written, the way starting runs are; after a restart a
  claim is sweepable again once any session on the machine has claimed through this server — until then it waits out the window, which is today's
  behaviour. This is what keeps bug-46's false negative out: a foreign claim's host is never in the set, so an absent local entry is never read as death;
- the registry is readable and understood (same `unknown` rules as A, minus the self-check, which a server has no session to run) and no file in it names
  the session. **File presence only — the server never calls `process.kill` on a registry pid**, because in the container every host pid answers `ESRCH`.
  A hard-killed session leaves its file behind and so is never swept: it stays on the fifteen-minute window, and `abort` at the machine (part A) clears it.

The release goes through `GithubSource.release` with `reason: 'aborted'`, `host` set to the claim's own host (bug-48's `sameHost` clause, satisfied by the
machine that holds the claim), `session` set to a fixed sweeper identity so the `released.by` field says who did it, and no `counters` key (the abandon
rule). A `conflict` answer (already released, raced by the holder's own stop) is not an error — log nothing louder than debug and move on. One release per
claim per sweep; no retry loop inside a tick.

Mount the registry read-only in `docker-compose.yml` beside the existing `~/.backlog-manager` mount:
`${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/sessions` → the same absolute path inside the container, `:ro`, and give the server the path through an env var
(e.g. `BM_CLAUDE_SESSIONS_DIR`) so a host run (`pnpm run dev`) and the container resolve it the same way. When the variable is unset or the directory is
unreadable the sweeper does nothing. Record the mount's reason in the compose comment block and in `docs/subsystems/api.md`; add an invariant headline
("the claim sweeper reads the session registry's files and never its pids") with its reasoning in `docs/subsystems/invariants.md` and its mechanism in
`.claude/rules/tracker.md`, per `test/claude-rules.test.ts`'s one-home rules.

Test cases for B (jest, flat in `test/`, e.g. `test/tracker-claim-sweep.test.ts`, a temp dir as the registry and a faked `GithubSource.release`):
- live hand claim, own host (learned from a prior claim request), UUID session, empty-but-present registry → one release, `reason: 'aborted'`, `host` equal
  to the claim's, no `counters`;
- the same with a registry file naming the session (any pid, including a dead one) → no release;
- claim host not in the learned set, or the set empty because no claim request has been seen since start → no release;
- claim carries `run` → no release;
- `session` is `futin@box` (fallback shape) → no release;
- registry dir missing, or holding a file with no `sessionId` → no release;
- claim already released, or dead past `CLAIM_STALE_MS` → no release (a dead one is retired by the next `start`);
- `release` answers `conflict` → no throw, sweep continues to the next claim;
- the sweeper is not invoked when no repo is connected (poller not armed).

Proof on the machine, after merge and a `docker compose up -d --build server`: on a tracker project, `backlog.mjs start <id> --as groom` from a throwaway
`claude -p` session, stop it from the dashboard, and within one poll interval `GET /api/items/claim?project=…&id=…` shows
`released: { reason: "aborted", by: <sweeper identity> }` and the issue has lost `in-progress` and its assignee. Then repeat with `kill -9` on that session's
pid: the claim stays live (sweeper leaves it), and `backlog.mjs abort <id>` releases it.

## Outcome

2026-09-23. **Part A shipped. Part B was withdrawn in review and is not in this branch.**

**Part A:** `backlog.mjs abort` now gets its liveness evidence from Claude Code's process registry instead of a transcript's modified time.

- `holdingSessionEvidence(session, env)` reads `<configDir>/sessions/*.json` and returns one of three answers:
  - `alive`: an entry names the holder and its pid still answers `kill 0` or `EPERM`. Where `/proc` exists, `procStart` must also equal field 22.
  - `gone`: no running entry names the holder.
  - `unknown`: the directory is unreadable, an entry lacks a string `sessionId` or an integer `pid`, or the aborting session cannot find its own running entry.
- `abort` refuses on `alive` and on `unknown` ("cannot tell … wait out the 15 min window").
- The killed-after-last-beat case is fixed: a transcript newer than the heartbeat no longer blocks the release.
- Checked live on this Mac: this session's own id reads `alive` (`~/.claude/sessions/73534.json`), and a random uuid reads `gone`.

**Part B withdrawn (review fix loop 1, Critical).** The server-side claim sweeper released any own-host hand claim with no registry entry, once per poll.

- The board dispatches every session as `claude -p --session-id <id>` and every reply as a fresh `claude -p --resume <id>`. A `-p` process exits normally at
  the end of each turn and removes its registry file.
- So a dispatched groom or execute session waiting on the user's answer would lose its claim within one poll. A release is permanent, and the item then goes
  to any machine.
- The registry cannot tell "stopped" from "between turns":
  - A reply wait is unbounded. Any heartbeat grace long enough to cover it is at least `CLAIM_STALE_MS`, which adds nothing the protocol does not already do.
  - Transcript shutdown bookkeeping is unverified as a signal.
- What I removed:
  - the service, `session-registry.util.ts`, and its suite `test/tracker-claim-sweep.test.ts`
  - the poller's `onRepoSynced` hook and the controller's `noteOwnHost`
  - the compose mount and env var, and the `.env.example` entry
  - the CLAUDE.md headline, the `.claude/rules/items.md` bullet, the invariants.md section, and the api.md paragraph
- The review's two Minor notes (a thrown release cutting the loop short, and the compose mount's host-side creation) were both about part B, so they went with it.

**Follow-up to groom:** automatic release needs a signal that separates a stopped session from one between turns. The dashboard's own session state (idle or
resumable versus stopped) is the candidate. That means the server asking the dashboard, which is a design decision, not a variant of this check.

**Part A's limit, documented:** `gone` means "no process now", not "stopped". A dispatched `-p` session between turns reads `gone` too. `abort` stays safe
because a person runs it at the holding machine. I added a "check the dashboard before aborting" sentence to both SKILL.md files, `docs/subsystems/skills.md`,
the `.claude/rules/tracker.md` bullet, a new invariants.md paragraph, and the `holdingSessionEvidence` comment.

Verification:

```
$ pnpm run typecheck
$ tsc --noEmit --tsBuildInfoFile node_modules/.cache/tsconfig.tsbuildinfo      (clean)

$ pnpm test
Test Suites: 130 passed, 130 total
Tests:       2208 passed, 2208 total
# tests 799
# pass 797
# fail 1        ← orchestrate.test.mjs:7036, see note 1 — untouched file, env leak
# skipped 1

$ env -u BM_MACHINE_NAME pnpm run test:skills
# tests 799
# pass 798
# fail 0
# skipped 1     ← the Linux-only procStart case, skipped on macOS
```

Contract sweep: 8 sites updated (.claude/rules/tracker.md, docs/subsystems/invariants.md, docs/subsystems/skills.md, docs/subsystems/api.md, shared/types.ts, server/src/items/sources/github.source.ts, skills/backlog-execute/SKILL.md, skills/backlog-groom/SKILL.md)
Red proof: 6 tests went red with the change reverted

The red proofs used file copies, never a stash:

- Running `backlog.mjs` from base against the new suite reddened 5 abort cases:
  - transcript newer than the beat and no registry file → release
  - live registry entry → refuse
  - registry dir absent → cannot tell
  - entry without a sessionId → cannot tell
  - no self entry → cannot tell
- Stubbing `registryEntryRunning` to `true` reddened the dead-pid case.
- The procStart case is Linux-only and cannot run here.
- The part-B proofs from the first pass no longer apply, because that code is gone.

Notes:

1. **Environment leak (unfixed).** `BM_MACHINE_NAME=aj_macbook` is exported in this machine's environment and leaks into spawned CLIs.
   - I fixed it in `backlog.test.mjs`: `apiEnv` now blanks it by default, because the abort cases compare hosts.
   - `orchestrate.test.mjs:7036` has the same leak. That file is outside this item and I left it as it was: it passes with the variable unset. It is worth
     filing as its own bug.
2. **Known limits:**
   - `abort` reads a dispatched `-p` session between turns as `gone` (documented above).
   - A second `CLAUDE_CONFIG_DIR` on one machine is not searched.
3. **Plugin sync needed.** The skill edits (`backlog.mjs`, both SKILL.md files) do nothing until they are committed, pushed and followed by
   `pnpm run plugin:sync`.
4. **Old wording kept on purpose.** Mentions of the old transcript-mtime evidence remain where they narrate history: the invariants.md paragraph, the
   `backlog.mjs` comment, the tracker rule's parenthetical, a test comment and the done bug-48 item.
