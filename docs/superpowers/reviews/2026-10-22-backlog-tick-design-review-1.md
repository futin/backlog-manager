# Review 1 — `docs/superpowers/specs/2026-10-22-backlog-tick-design.md`

Date: 2026-10-22. Reviewer: fresh subagent (Fable), checklist review, read-only. Doc lines cite the spec as it stood at review time (233 lines).
External source checked: `claude-agents-dashboard/docs/superpowers/specs/2026-10-19-scheduled-workflows-design.md` plus its `shared/cron.ts` and
`shared/schedule-file.ts`.

## Verdict: REVISE

No Critical finding. Eight Important ones — one false statement about the code, one example that the outside source refuses, and six places where an
implementer has to guess (approval semantics on a files project, liveness of a marker, the tracker-with-stack-down path, when the failure hash is taken, the
busy check's blind spot in linked worktrees, and how open PRs are counted). Each is a sentence or two to fix; none changes the design.

## What was verified and holds

- Dashboard job file keys, `foreach: pinned`, `permission-mode: auto`, `run: claude`, `machines:` — spec §"The job file" (lines 77–88). `timeout: 90m`
  parses (`shared/schedule-file.ts:203`, `<n>(s|m|h)`). `CLAUDE_DASHBOARD_SCHEDULE=<job>` and `--disallowed-tools AskUserQuestion` — spec line 208. A step is
  `ok` on `is_error: false`, so a tick that reports `failed` in prose sends no push — spec lines 197–199. The step's cwd is `PinRow.path`, which can be a
  linked worktree — spec line 101, so the no-op-on-linked-worktree call is warranted.
- `backlog-execute --finish pr`: never reuses the main checkout, reuses a clean linked worktree on its own branch (`references/pr-mode.md:58, 287`), cuts
  `.worktrees/execute-<id>` on `execute/<id>` from local `<base>` (`pr-mode.md:80–88`), refuses when either already exists (`:85`), writes the marker inside
  `<tree>` (`:147`), refuses an uncommitted item (`:147–148`), stops on a permission denial (`:259–267`), re-checks drift (#323, `SKILL.md:222–240`).
- Ten tracker labels, `IN_REVIEW_LABEL`, `TRACKER_LABELS` order rule — `server/src/tracker/labels.ts:72–86`. Nine `@Post` routes in
  `items-write.controller.ts:80–273`; `abort` is `server/src/agents/items-abort.controller.ts:20`. `queued`/`inReview` spreads in `map-issue.ts:247–254`.
  `inReviewBlock` chained in `agents.service.ts:421, 503` and `DispatchButton.tsx:172`; `dispatchBlock` project-level (`shared/agent.ts:447`).
- `backlog.mjs`: `--runner-fix` on `new` and `body` (`:2190, 2240`), `stop <id> --abandon` (`:2217`), `review <id> on|off` (`:3662`), `drift` (`:2606`).
- `orchestrate.mjs plan --json` (`:3387`), `$BM_ORCH_HOME` (`:268`), runner-fix hoist (`:1314`), `not committed on <base>` (`:1726`), in-review gate
  (`:2034`), `drift-lib.mjs` in both tool dirs with `drift-lib.test.mjs:3,16–23` asserting the copies match.
- Claim staleness is 15 min (`CLAIM_STALE_MS` aliases `RUN_STALE_MS = 15 * 60 * 1000`, `shared/types.ts:1599, 2199`). Run statuses include `paused`
  (`shared/types.ts:1626`). `main` merges squash-only (`CLAUDE.md:272`, `docs/workflows/ci.md:48`).
- Groom's three verdicts are promote, plan-the-fix, reject (`skills/backlog-groom/SKILL.md:14, 123–130`); there is no "plan an existing task" verdict, so
  line 217 holds. Unknown frontmatter keys round-trip through `start`/`stop` and the server's parser (`.claude/rules/skills.md:33`, `parse.util.ts:18`), so
  `plan-review: true` survives on a files item.
- CLAUDE.md:3 says "seven skills, six of them backlog skills"; `skills/backlog/SKILL.md:157` says "a closed ten".

## Important

### I-1 — doc:76 — the example cron is refused by the dashboard

`cron: "*/30 22-6 * * *"`: the dashboard's parser rejects a backwards range outright — `claude-agents-dashboard/shared/cron.ts:67`
`if (lo > hi) return bad('range runs backwards')` — and `PUT /api/schedules/:name` answers `422` with nothing written (dashboard spec line 257). The spec's
own canonical job file cannot be saved. The step `*/30` is fine (expanded to launchd intervals, dashboard spec lines 148–149).
→ Use a list of forward ranges, e.g. `cron: "*/30 0-6,22-23 * * *"`, and note that a wrapping range is refused.

### I-2 — doc:147 — groom has no `[orchestrator-run` mode today

"Groom and execute today know one unattended mode, the `[orchestrator-run` marker" is false for groom: `skills/backlog-groom/SKILL.md` contains no
occurrence of `orchestrator-run` (the only "headless" mentions, `:275` and `:322`, describe the execute session that will later read the plan). The
orchestrator never dispatches groom. Groom's current rule is the opposite of unattended: "wait for the user to confirm or pick a different one" (`:135`),
satisfied only when "a prompt that already named the item and the verdict" (`:142–144`). So the `[backlog-tick]` marker is groom's FIRST unattended mode,
and everything under "Never ask" (doc:150–156) is new text for groom, not an adaptation.
→ Correct the sentence to execute alone. Then say explicitly that the tick's groom trigger names the verdict along with the id — a bug is "plan the fix",
a `ref-N` is "promote" (decision 7 already fixes the mapping) — so groom's existing consent gate at `:142` is satisfied by the prompt rather than by a
new rule.

### I-3 — doc:164–165 (with doc:115–116) — approving on a files project needs a commit, and the spec does not say which tree `plan-review` is read from

Step 3 requires an execute candidate to be "committed on the base" (doc:115) and execute's `pr` finish cuts its tree from local `<base>`
(`references/pr-mode.md:76–77`) and reads the item there (`:147`). A user who "deletes the frontmatter line to approve" (doc:165) but does not commit leaves
`plan-review: true` in the committed copy: if `decide` reads the working tree it hands out `execute <id>`, execute's new refusal gate (doc:180) refuses "this
plan awaits review", the tick records `failed` keyed by the base hash, and the item sleeps until the commit lands — a confusing night with no reason shown
anywhere. Nothing in the doc says where step 3 reads the mark, and the Non-goals paragraph (doc:34–35) actively says committing is not approving.
→ State that the execute candidate's `plan-review` (and `in-review`) check reads the item at `<base>`, like the groomed check, and that approval on a files
project is "remove the line AND commit it" (or `/git-sync` will). Keep the Non-goals sentence but qualify it: the commit carries the approval, it does not
grant it.

### I-4 — doc:139–141 — "with no live session" is undecidable on a files project

The dead-tick recovery clears a `started:` marker "if that item still carries a `started:` marker with no live session". On a files project the marker
"records _when_, never _who_" and "the tool cannot tell you whose" (`skills/backlog-groom/SKILL.md:166–171`); the only liveness proof in the repo is
`backlog.mjs abort`'s session-registry check, which is tracker-only (`skills/backlog-execute/SKILL.md:213–214`). An implementer has to invent the check or
drop the clause; the doc's own next sentence ("it is provably its own") argues the stale lock is the proof.
→ Make the proof exactly: lock older than the ceiling AND its verdict names `<id>` AND `<id>` carries `started:` with `phase: groom` (a `pr` execute's
marker is in the worktree, doc:142–143). Delete "with no live session", or define it as that triple.

### I-5 — doc:104–110, doc:212 — a tracker project with the stack down has no stated verdict

The doc settles only the board-started check for a down stack (doc:106–107, 212). On a tracker project every `backlog.mjs` verb needs the API and exits
`5` (`.claude/rules/skills.md:21–24`, CLAUDE.md invariant), the claim busy-check (doc:108) is an API read, the `plan-review` count is a label read, and
`start` inside groom/execute would fail. As written, `decide` on such a project either crashes or hands out a verdict the skill cannot act on.
→ Add to step 2 (or before it): tracker source and the API unreachable → `idle: stack down`, exit 0, no lock taken. Files projects are unaffected.

### I-6 — doc:186–189 — the failure hash must be taken after the skill's own `stop`, or a failed files groom is retried every tick

A tick groom always runs `start --as groom` and `stop` (`skills/backlog-groom/SKILL.md:140–150, 334–338`), and both rewrite the file: `updated:` is stamped by
every `start` and `stop`, and `stop` bills `groom-elapsed:` / `groom-tokens:` (`.claude/rules/skills.md:46–49`). A hash of "the item file … the working
tree for groom" taken when the groom begins, or before its `stop`, never equals the file the next tick sees, so the record never matches and the "no retry
loops" goal (doc:28, 47) fails on exactly the case it was written for. For execute the base copy is stable, so only groom is affected.
→ Say that `record` computes the hash at record time, after the skill's `stop` has run, and that a hand `start`/`stop` (which re-stamps `updated:`)
re-arms the item on purpose. Alternatively hash the body plus the non-tool frontmatter keys only.

### I-7 — doc:108–109 — the files busy check sees only the main checkout

"Any open item carrying a `started:` marker (files) … a human or another session is grooming or executing": an in-place execute or a groom run inside a
LINKED worktree writes its `started:` into that tree's copy of the item (`skills/backlog-execute/SKILL.md:176`; a `pr` finish's marker likewise,
`references/pr-mode.md:147`), which the main checkout's `backlog/` does not show. The `pr` case is caught by the `execute/<id>` branch rule (doc:117), the
in-place-in-a-worktree case by nothing — two sessions on one item, the anti-goal at doc:46.
→ Either state the limitation (markers in linked worktrees are not seen, the same blind spot the orchestrator's gate has) or have `decide` read the item
across `git worktree list --porcelain` trees too. Say which.

### I-8 — doc:111 — how open PRs are counted, and whose

"Open tick PRs = `execute/<id>` branches whose PR is open, read with `gh pr list --head`": `--head` takes one branch (execute uses it per id,
`skills/backlog-execute/SKILL.md:162`), so counting means either one call per local `execute/*` branch — which misses a PR whose local branch was pruned —
or `gh pr list --state open --json headRefName` filtered on the `execute/` prefix. The second also counts a hand-run `--finish pr`, which the goal (doc:27)
calls "tick PRs" and cannot distinguish. Either reading changes what `--max-prs` means.
→ Define the count as every open PR whose head starts with `execute/` (one `gh pr list --state open --limit … --json headRefName`), and rename the cap
to "open execute PRs" in Goals and decision 5.

## Minor

- doc:176–177 — "CLAUDE.md's Layout line that still says 'nine guarded write routes'" implies it is stale; it is correct today: nine `@Post` routes in
  `items-write.controller.ts:80–273`, `abort` in `server/src/agents/items-abort.controller.ts:20` is the tenth `/api/items/*` write. The one genuinely stale
  count is `docs/subsystems/invariants.md:3076` ("The nine `/api/items/*` writes"). Also add `test/tracker-labels.test.ts:46` (`toHaveLength(10)`) and its
  `describe('the ten labels')` to the list of sites that move.
- doc:138 vs doc:157–158 — "retired by the claim protocol on its own" vs "when `start` runs": the code retires a stale claim when the NEXT claimant claims
  (`server/src/items/sources/github.source.ts:498–507`), never on a timer. Align 138 with 157.
- doc:40 — "honouring `plan-review` the way it honours `in-review`": orchestrate's in-review gate is tracker-only (`orchestrate.mjs:1915–1916, 2034`), the
  files walk has no counterpart. doc:180 already requires both sources; say here that the files walk gains a frontmatter read.
- doc:111 — `idle: cannot count open PRs` reads as the tick's verdict, but step 4 may still return `groom <id>`; call it the reason step 3 contributes to an
  eventual `idle`.
- doc:153 — "writes nothing and reports `failed`": `start`/`stop` still write the marker and the counters; say "writes no verdict".
- doc:129–130 — a files promote: groom step 4 says "keep the printed frontmatter block exactly as printed" (`skills/backlog-groom/SKILL.md:265`); the
  tick-marker text must carve out the `plan-review: true` line the way `runner-fix: true` is already carved out (`:281`).
- doc:81, 229 — the dashboard job also accepts `max-turns:` (dashboard spec line 87); an execute that runs out of turns ends mid-work the same way a
  `timeout:` does, and the recovery path (doc:136–143) should name both.
- doc:91 — the dashboard heading is "The wrapper: `plugin/lib/run-schedule.mjs`"; fine as a reference, noted for exactness.
- doc:100 — the lock is per machine (`~/.backlog-manager` is local); for a tracker project worked from two machines the only cross-machine guard is the claim
  race at `start`. Worth one sentence since the spec otherwise presents the lock as closing the window.
