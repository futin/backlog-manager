# Review 2 — `docs/superpowers/specs/2026-10-22-backlog-tick-design.md`

Date: 2026-10-22. Reviewer: fresh subagent (Fable), checklist review, read-only. Doc lines cite the spec as committed in `bf89968` (258 lines).
External source checked: `claude-agents-dashboard/docs/superpowers/specs/2026-10-19-scheduled-workflows-design.md` and its `shared/cron.ts`.
Round 1's report is `2026-10-22-backlog-tick-design-review-1.md`; its findings are not repeated here unless still open.

## Verdict: REVISE

No Critical finding. Seven Important ones — two false statements about the code (one of them a path the recovery section tells the builder to run on a
tracker project, where the server refuses it), one undercounting shell command, and four places an implementer has to guess: the lock's lifecycle on a
verdict that acts on nothing, which tree the groom side reads on a files project, whether a remote orchestrator run counts as busy, and how the unattended
marker reaches two skills this repo does not own. None changes the architecture; each is a sentence or two, but I-4 is a decision the author has to make
rather than a wording fix, which is why this is REVISE rather than APPROVE WITH FIXES.

## Round 1 — what was fixed

All eight Important findings of round 1 are addressed in the text: the cron example is forward ranges (doc:77); the `[orchestrator-run` claim is execute-only
and groom's consent-by-prompt is named (doc:161–165); `plan-review` is read at `<base>` and approval on files is "delete the line and commit" (doc:183–185);
the dead-tick proof is the lock/verdict/marker triple (doc:150–152); a tracker project with the stack down is `idle: stack down` before the lock (doc:101–103);
the failure hash is taken by `record` after `stop` and excludes the tool-written keys (doc:209–211); the files busy scan reads linked worktrees (doc:114–117);
the PR count is every open PR whose head starts with `execute/` and the cap is renamed (doc:27, 62, 119–121). The round-1 Minors are all in too.

## What was verified and holds

- Dashboard: `shared/cron.ts:45–69` splits lists on `,`, accepts `*/30` and `0-6,22-23`; `timeout:` and `max-turns:` are job keys (dashboard spec 87–88);
  the step's cwd is `PinRow.path` (101, 364); `CLAUDE_DASHBOARD_SCHEDULE` and `--disallowed-tools AskUserQuestion` (208); a claude step is `ok` on
  `is_error: false`, so a prose `failed` sends no push (197–199, doc:254 holds); skills are reachable through the Skill tool (96, doc:136–138 holds).
- `GET /api/orchestrator/runs` carries `starting` (server memory, `orchestrator.controller.ts:20, 26`; `client/src/lib/agents.ts:185–202`) — doc:111 holds.
- Orchestrator run-state root is `$BM_ORCH_HOME` else `~/.backlog-manager/orchestrator/` (`orchestrate.mjs:262–268`); item trees are `.worktrees/<id>`
  (`:615, 4215`); the files gate reads the item at `<base>` through `readBlob` and reports `not committed on <base>` when absent (`:1711–1726`); the
  in-review gate is tracker-only (`:1905, 1915–1916, 2034`); `stale-plans.json` is written only by `orchestrate.mjs` (`:461, 526, 543, 3430`; no other writer
  under `skills/`, `server/`, `shared/`) — doc:240 holds.
- `backlog.mjs`: `apiBase()` is `BM_API_PORT` else `4322` (`:733–738`) and every tracker command needs it (`:755`, `.claude/rules/skills.md:19`) — doc:101
  holds; `stop <id> [--abandon] [--keep-started]` (`:2217`), `--abandon` skips billing and the `groomed-at:` re-stamp (`:1988–1991, 2016`); a plain groom
  `stop` re-stamps `groomed-at:` (files) or the `bm:groomed-at` body footer (tracker) (`.claude/rules/skills.md:51–52`).
- Tracker writes absorb their result into the poller cache (`github.source.ts:264, 299, 305, 386, 485, 509, 531, 687`), so a `record` that hashes the body
  after `stop` reads the stamped body, not a stale copy — doc:209, 213 hold.
- Labels: ten in `TRACKER_LABELS`, `IN_REVIEW_LABEL` exported, created by the poller's `ensureLabels` (`labels.ts:2, 21, 75, 78`; `poller.service.ts:971`).
  Item flags `runnerFix` / `queued` / `inReview` are optional `true`-or-absent (`shared/types.ts:302, 316, 324`), the pattern `planReview` would follow.
- Groom: headings "Three verdicts" (`SKILL.md:123`) and "Mark it in progress" (`:138`); consent by a prompt naming item and verdict (`:142`); promote keeps
  the printed frontmatter block (`:265`) with the `runner-fix: true` carve-out (`:283`); "If the session ends without a verdict" runs a plain `stop` (`:417–423`).
  Groom contains no `orchestrator-run`; execute's SKILL.md has eight mentions and the "never run anything in the background" rule (`:34–37`) — doc:161, 179 hold.
- Execute `pr` finish: tree `.worktrees/execute-<id>` on branch `execute/<id>` from `<base>` (`references/pr-mode.md:80–88`), refuses when either exists
  (`:85`), refuses an uncommitted item (`:147–148`), stops on a permission denial (`:259–267`).
- Count sites: CLAUDE.md:39 "nine guarded write routes" is correct today; CLAUDE.md:117, 119 and `.claude/rules/items.md:7`, `skills.md:30` say "ten";
  `invariants.md:3076` still says "nine" (stale) while its heading at `:3448` says ten; `skills/backlog/SKILL.md:157` "a closed ten";
  `test/tracker-labels.test.ts:32` `describe('the ten labels')`. CLAUDE.md:3 "seven skills, six of them backlog skills".
- `isItemId` accepts three shapes (`shared/agent.ts:705–707`); tracker ids carry `#`.

## Important

### I-1 — doc:104–108, 142 (with 94, 99) — the lock's lifecycle on an `idle`/`busy` verdict and under `--dry-run` is unstated

Step 1 takes the lock before the busy check and the two candidate steps, and the only release the spec names is `tick.mjs record <id> …` (doc:142), which
takes an item id a `busy: …` or `idle: …` verdict does not have — and doc:99 says an idle tick is "one tool call", i.e. `decide` alone. Read literally, every
idle or busy tick leaves a fresh lock behind, and step 1's own rule ("Held and fresh → verdict `busy: another tick`") makes the next tick on that project idle
for the 3 h ceiling — on a repo with nothing to do, every second tick is a false `busy`. `--dry-run` (doc:94, 243) "prints the decision without acting" and,
if it goes through `decide`, leaves the same lock with nobody to `record` it.
→ Say that `decide` writes the lock only when its verdict is `execute <id>` or `groom <id>` (or writes and releases it itself before printing any other
verdict), and that `--dry-run` never writes the lock. One sentence in step 1 and one in doc:94.

### I-2 — doc:132–134 (with 183–185, 34–35) — on a files project, which tree the groom cap and the groom candidate read

Step 3 reads groomed-ness and `plan-review` at `<base>` (doc:125, 183), the tree orchestrate's gate reads (`orchestrate.mjs:1711–1726`, `readBlob`). Step 4
says the `plan-review` count is "counted the same way on both sources" and the candidate is an "ungroomed bug", but names no tree. A tick's groom is
uncommitted by design (doc:34) and `/git-sync` is the committer, so on a night of ticks the working tree and `<base>` disagree on exactly the items that
matter. If step 4 reads `<base>`: last night's grooms carry no `plan-review` there, the N cap never fills (the anti-goal at doc:52), and bug-1 groomed at
23:00 is still "ungroomed" at 23:30 and is groomed again — its plan overwritten, since the tick's own `stop` cleared the marker that would have blocked it.
If it reads the working tree, both work. The board derives groomed-ness from the working tree (the server reads the files), so that is presumably the intent.
→ State it: on a files project step 4 — the `plan-review` count and the groomed/ungroomed derivation — reads the working tree, step 3 reads `<base>`, and say
in one clause why the two steps read different trees.

### I-3 — doc:146–157 — the recovery path is written for files; on a tracker project the clearing step is refused by the server

The paragraph tells the builder the tick "clears that one marker with `backlog.mjs stop <id> --abandon`" once the lock/verdict/marker proof holds. The
proof is frontmatter (`started:` with `phase: groom` "in the main checkout") that a tracker item does not have, and a tracker `stop` from the next tick's
session is a release by a stranger: `GithubSource.release` is holder-only — "Who may release: the holder always, the RUN that owns the claim, …"
(`server/src/items/sources/github.source.ts:547–560`) — so it is refused with the dead holder named. The section's own earlier sentence (doc:148–149) already
gives the tracker answer: the stale claim is retired when the next claimant's `start` runs (`:498–507`). Two more things the paragraph leaves open: whether an
`execute <id>` dead lock is recorded `failed` (doc:154 says only that it "needs no clearing"), and that a tick inside the 15 min staleness window on a tracker
project sees a live claim and reports `busy` — correct, but worth saying so nobody "fixes" it.
→ Split the paragraph by source. Files: the triple proof, `stop --abandon`, record `failed (killed at timeout)`, release. Tracker: no clearing, record
`failed`, release; the claim retires itself at the next `start`. Both: an `execute <id>` verdict is recorded `failed` the same way, the worktree it left is
what keeps the item off the list.

### I-4 — doc:110–112 (with 22, 47) — a remote orchestrator run is not a busy signal, and the API already reports one

The busy check reads this machine's `run.json` and the `starting` entries. `GET /api/orchestrator/runs` also carries `remote` — `RemoteRun`, "a run of this
tracker repo on another machine", derived from the tracker cache (`server/src/orchestrator/orchestrator.controller.ts:55–70`; `shared/types.ts:1902`;
CLAUDE.md "Remote runs ride beside `runs`, never in it"). The anti-goal at doc:47 names "a tick and an orchestrator run working … the same project, at once",
and doc:22 says "if anything is already happening to this project's backlog". A remote run holds a claim only while it is inside an item; between items it
holds none, its next item carries only `orchestrator:queued` (a plan, never a claim — CLAUDE.md invariant), and the tick would claim it first. The claim race
(doc:107–108) covers the same item, not the same project.
→ Add a bullet to step 2: on a tracker project, a `remote` entry for this repo whose status is `running` or `paused` and that is `fresh` → `busy: remote run`
— or decide explicitly that a remote run is not busy and say why the anti-goal does not apply. Either way the spec must say which.

### I-5 — doc:119–120 — `gh pr list` without `--limit` returns at most 30 pull requests

The count is defined as the output of `gh pr list --state open --json headRefName` filtered on `execute/`. `gh pr list`'s documented default is `--limit 30`,
so a repository with more than thirty open PRs (Dependabot alone gets there) reports whichever thirty GitHub returns first, and the M cap undercounts —
the "maximum" edge case of this check. The flag the implementer copies from the spec is the one that ships.
→ Write the command with an explicit `--limit` large enough to be a ceiling nobody reaches (e.g. `--limit 500`), and say that a count at the limit is treated
as "cannot count open PRs" like a missing `gh`.

### I-6 — doc:167–168, 172 — how the marker's "never ask" reaches `superpowers:brainstorming` and `writing-plans`

Groom invokes `superpowers:brainstorming` whenever a promote's open questions are real (`skills/backlog-groom/SKILL.md:232–233`) and for a fix that needs
design (`:314`), and `writing-plans` after an Architectural brainstorm (`:245`). Both are skills this repo does not own; their text is "ask one question at a
time", and under `--disallowed-tools AskUserQuestion` a step that follows it asks in prose and ends the turn (dashboard spec 208–212) — the anti-goal at
doc:49–50. The spec requires that "every question they would put to the user is answered by the session" but says nothing about the mechanism, and a
`[backlog-tick]` marker in groom's SKILL.md is not read by brainstorming. The user's own global learnings record that a superpowers template wins unless the
override is in the invoking prompt itself.
→ Name the mechanism: under the marker, groom either does not invoke brainstorming/writing-plans and settles the questions inline under
`Assumptions (unattended)`, or invokes them with Skill args stating "no user is present — decide each question yourself and list it under Assumptions
(unattended)". Pick one and write it into the marker section.

### I-7 — doc:127–128 — "a failed or still-open execute leaves both" is false for a refusal before work

`references/pr-mode.md:113–124` ("A refusal before any work leaves nothing behind"): when `show`, the refusal gate, the claim race or any stop before `start`
ends the session after a new tree was cut, execute removes `.worktrees/execute-<id>` and `execute/<id>` (guarded by `rev-list --count <base>..execute/<id>`
printing `0`). So the branch/worktree exclusion covers a killed or still-open execute only; a refused one is kept off the candidate list by the failure record
alone. That matters for doc:256–258: a `blocked` outcome "that does not key on the hash" for an environment-caused refusal would, with no tree left behind,
be picked again every tick — the retry loop the goal at doc:28 forbids — unless `blocked` carries its own cool-down.
→ Correct the sentence ("a killed or still-open execute leaves both; a refusal before work removes them, pr-mode §2"), and in the `blocked` paragraph say what
keeps a `blocked` item off the next tick (a time-based cool-down, or "blocked skips the item for the rest of the night").

## Minor

- doc:196–199 — more count sites move: `.claude/rules/tracker.md:90` ("the nine `GithubSource` writes" — the new label route is a tenth), `tracker.md:80` and
  `docs/subsystems/invariants.md:3171` ("the ten labels"), and the anchor `#the-ten-item-write-routes-are-guarded-refused-for-files-and-serialised-per-item`
  linked from CLAUDE.md:120 and `.claude/rules/items.md:29`, which changes when the heading at `invariants.md:3448` does. "The rules file" is two files
  (`items.md:7, 12`; `tracker.md:80, 90`).
- doc:164 — `groom bug-<n>` / `groom ref-<n>` are files-shaped ids; a tracker item is `#<n>` (`shared/agent.ts:705–707`, three shapes). Say "the item's id
  in the project's own shape", or the tracker example will be transcribed as a files one.
- doc:88 — "(not registered, no `backlog/`)" reads as both conditions; say "either".
- doc:111–112 — "read through the API when the stack is up": say the probe is `apiBase()` — `BM_API_PORT`, default `4322` (`backlog.mjs:733–738`) — so a files
  project probes the port the skills already use rather than a second constant.
- doc:116 — the orchestrator also makes `.worktrees/_base-<base>` (`orchestrate.mjs:4097–4099`); either name it with the other two skipped kinds or say
  "every `.worktrees/` tree the orchestrator makes". Harmless if scanned (it mirrors base), but the rule as written does not cover it.
- doc:105 — the 3 h ceiling is "comfortably above any sane job `timeout:`", but the dashboard accepts `2h`, `4h`… (spec 88). A `timeout:` above `--lock-ttl`
  replaces a live tick's lock and runs two ticks on one project (anti-goal doc:47). Say the schedule author keeps `timeout:` below `--lock-ttl`, or that
  `decide` refuses when it can read a longer one.
- doc:157 — "the `execute/<id>` worktree it leaves": the worktree is `.worktrees/execute-<id>`, the branch is `execute/<id>` (`pr-mode.md:80–88`).
- doc:209–212 — "a hash of the item file" contradicts "only over the item's body plus the frontmatter keys a person edits" two lines above; say "of the item
  file's body and person-edited keys".
- doc:132 — "in board order": name the sort, as step 3 names orchestrate's; otherwise two implementers pick two orders.
- doc:171 — on a tracker project a failed groom's plain `stop` re-stamps the `bm:groomed-at` body footer (`backlog.mjs:1988–1991`, `.claude/rules/skills.md:51–52`),
  so the body changes on every attempt; record-after-`stop` (doc:209) covers it, but a builder who hashes the tracker body before `stop` reintroduces round 1's
  I-6. One clause in the failure-record section.
- doc:34–35, 60 — a `/git-sync` job whose cron line overlaps the tick's commits a live tick groom's `started:` marker onto base; the next tick's busy check then
  blocks the project until a human clears a committed marker. An existing hazard for any session, but since the spec names `/git-sync` as the committer, one
  sentence telling the schedule author to keep the two jobs' lines apart is cheap.
- doc:192–193 — the label description: the other ten are short noun phrases (`labels.ts`); fine as drafted, noted only so the final text is exact when written.
