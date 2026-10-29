# Review 1 — Source sections: Files, GitHub and Jira at the rail's root

Document: `docs/superpowers/specs/2026-10-29-source-sections-design.md` (137 lines). Reviewer: fresh subagent (Fable), checklist as dispatched.
Every claim below was checked against the worktree at `cb41418`; `file:line` cites are to that tree.

## Verdict: REVISE

One Critical (the documented change set fails `test/claude-rules.test.ts` as written), eight Important (contradictions between sections, requirements an
implementer must guess, and missing edge cases on the GitHub calls). Nothing here questions the decisions; every fix is a sentence or two in the spec.

## Critical

### C1 — spec:80-82 — the new write invariant's change set omits the `.claude/rules/` bullet, which fails CI

The spec says the three PR writes "must be added to that list [CLAUDE.md] and to `invariants.md` as their own entry". The repo's rule tiers are three, not
two: `test/claude-rules.test.ts:16-17` requires that CLAUDE.md's linked headlines (tier one) and the `.claude/rules/*.md` bullets (tier two) are "the same
multiset of (anchor, headline) with one home per anchor". A CLAUDE.md bullet of the shape `- **headline** Why: [invariants.md](...#anchor)` with no rules
bullet carrying the same anchor fails that suite — and CLAUDE.md's own "Invariants" preamble says the same. The same applies to spec:99-100 if the
"Settings is three pages" headline is reworded to admit a host-scoped card on GitHub › Settings.

Fix: name the rules file for each new or changed entry — `.claude/rules/tracker.md` for "The board's GitHub PR writes are merge, auto-merge and
update-branch, nothing else" (mechanism: routes, guard, per-PR serialisation, re-read, "GitHub API calls, never local git"), and `.claude/rules/board.md`
for any change to the Settings/tree headline — and state that the headline is byte-equal in all three homes.

## Important

### I1 — spec:46, spec:91-92 — moving the Trackers card breaks the pinned sync-off sentence, and the spec is silent

`TrackerPollerService.syncOffBlock` is "the ONE server home of the sentence `sync is off for <owner/name> — turn it on in Settings › Shared › Trackers`"
(`.claude/rules/tracker.md`, "A repo whose sync is off…"); the literal is at `server/src/tracker/poller.service.ts:523`, its client copy at
`client/src/lib/tracker.ts:253`, and it is pinned verbatim by `test/tracker-lib.test.ts:473`, `test/tracker-sync-refusals.test.ts:31`,
`test/tracker-sync-interval.test.ts`, `test/tracker-board.test.tsx` and `test/tracker-abort.test.ts`. Once the interval picker lives on GitHub › Settings, the
sentence points at a page that no longer holds the control. `.env.example:104-105` and `:109-110` also say "the Trackers card in Shared Settings".

Fix: give the new sentence (e.g. `… turn it on in GitHub › Settings`), say the server literal, the client copy and the five pinning suites move together,
and list `.env.example` among the docs that follow.

### I2 — spec:40 vs spec:19 and spec:121 — the Files row's draw rule is stated two ways

spec:40 (Decided by the person): "drawn only while at least one registered project is a files project". spec:19 and spec:121: drawn while ≥1 project has
source `files`, `unsupported` or `null`. `ProjectSummary.source` is `SourceKind | 'unsupported' | null` (`shared/types.ts:441`), so these are three distinct
values and the two sentences disagree for a machine whose only registered project has a broken or missing marker.

Fix: reword spec:40 to "a files project, or one whose marker cannot be resolved (see Left to the builder)".

### I3 — spec:31-33, spec:119-125 — the Files/GitHub rows' hold-and-fall has no named answer and no "unknown" branch

The Jira row's hold-and-fall is decided on one answer, `GET /api/jira` through the shell's one `useJira` (`client/src/components/SideRail.tsx:116`,
`client/src/App.tsx:164-181`), and `resolveSection` runs in a `useState` initializer before any answer exists (`App.tsx:61-63, 91`). The spec does not say
which read decides "≥1 registered `github`/`files` project" — `TrackersPayload.projects[].source` (`shared/types.ts:544`), already in the shell through
`TrackersProvider` (`App.tsx:67`) but fetched once and then never again when no github row syncs (`client/src/hooks/useTrackers.ts:19-21`), or
`GET /api/projects` (`server/src/items/items.controller.ts:21`) — nor what the shell draws while it is unknown. spec:125's "a stored `board` resolves to
GitHub › Board if any `github` project is registered" cannot be computed in the initializer at all.

Fix: name the answer and its hook, and state the three branches as the Jira rule does: unknown → hold the stored/migrated section and keep its row;
answer says the row exists → keep; answer says it is gone → fall (spec:123). State that the stored `board`/`archive` migration is applied on the first
answer, not in the initializer.

### I4 — spec:124 vs spec:125 — a stored `board` on a machine with nothing registered lands on an undrawn row

spec:124: "A machine with nothing registered opens on Runs." spec:125: a stored `board` resolves to GitHub › Board "if any `github` project is registered,
else Files › Board" — unconditionally, so on that same machine it lands on Files › Board, whose row spec:19 does not draw. That is the blank-page case
spec:74 names as an anti-goal.

Fix: "else Files › Board while the Files row is drawn, else the fallback of spec:123".

### I5 — spec:115 vs spec:31 — the Sources card's "linking to that source's section" contradicts the tree rule as the existing card applies it

The Trackers card's Jira row draws `Jira › Setup` as text, not a link, because "the rail's tree is the only thing that switches sections or pages"
(`client/src/components/settings/TrackersGroup.tsx:49-50`); the Jira rule's one allowance is "a link threaded down from" the rail's pair, which is
`onOpenJiraPage` built in `App` as `setJiraPage(p)` then `change('jira')` (`App.tsx:188-191`; `.claude/rules/board.md`, "The Jira section's two pages…").
spec:115 says each Sources row links to its section or settings page without saying which of the two it is.

Fix: either drop the links (text, like today's Jira row) or state that each is an `onOpen<Source>Page` pair built once in `App` and handed down, never a
page-local switch.

### I6 — spec:44-45 — the run-in-progress chip needs a PR-head → run/claim rule the spec does not give

A run file carries only `base` (`shared/types.ts:1065`), a claim comment carries no branch (`server/src/tracker/claim.ts`), and the branch names are
conventions in the skills: per-item `backlog/<id>` and PR-mode run branch `backlog/run-<date>-<n>` (`skills/backlog-orchestrate/tools/orchestrate.mjs:3145-3177`),
execute `execute/<id>` (`skills/backlog-execute/references/pr-mode.md:213`; `skills/backlog-tick/tools/tick.mjs:275` already matches heads by that prefix).
Without a stated rule, the implementer picks one and the chip is right or wrong by accident.

Fix: state the mapping — head `backlog/<id>` or `execute/<id>` ↔ an item in a live or paused run's items, a starting entry's ids, or a live claim on that
issue; head equal to a running/paused run's `base` (branch or pr mode) ↔ that run; anything else draws no chip — and that it is one function in `lib/`.

### I7 — spec:89-90 and spec:128 — cache-vs-per-request is left open, but a poll cadence is fixed, and the read's shape and budget are unstated

spec:128 polls "through `useCoalescedFetch` at the tracker cadence". The tracker cadence is per repo (`15s`/`1m`/`5m`, `.claude/rules/tracker.md`) and the
client follows it by aiming at `polledAt`, which is why `useTrackers` is NOT built on `useCoalescedFetch` (`client/src/hooks/useTrackers.ts:9-25`,
`useJira.ts:31`, CLAUDE.md #231 exception); `useCoalescedFetch` takes a fixed `intervalMs`. So "the tracker cadence" names no number. If the reads are
per request (spec:90's second option), a 15 s client poll is per-request fetching from GitHub, which the cache invariant's own reasoning calls impossible
("the hourly rate limit makes a per-request fetch impossible", `.claude/rules/tracker.md`, "The tracker and Jira caches…"), and "Rate limits are values,
never exceptions: a sleeping repo gets no request at all" is not mentioned for PR reads. The read is also N+1 per repo: `GET /repos/{r}/pulls` carries
`draft` and `auto_merge` but not `mergeable`/`mergeable_state` (only `GET /pulls/{n}` does, and `mergeable` is `null` while GitHub recomputes), checks
are a per-head-SHA read, and a review decision is GraphQL `reviewDecision` (REST has only the reviews list) — multiplied by every open tab on the page.
`GithubClient` is REST-only today (`server/src/tracker/github.client.ts:30, 282-291`); spec:94 already requires GraphQL for auto-merge.

Fix: decide one: a server-side per-repo PR cache, filled on demand with a TTL while a PRs page is asking (so nothing polls with nobody on the page,
spec:87-88), `polledAt` rendered and the cache invariant updated to three; one batched GraphQL read per repo (`pullRequests(states: OPEN)` with
`isDraft`, `mergeable`, `mergeStateStatus`, `reviewDecision`, `autoMergeRequest`, `commits(last:1).statusCheckRollup`, `headRepository`); a fixed client
interval in seconds; and that a rate-limited repo's PR read sleeps with its issues read.

### I8 — spec:43, spec:95-96, spec:128-132 — the three writes' failure and timing edge cases are missing

Only the permission failure is described (spec:95-96). Not covered: GitHub's update-branch answers `202 Accepted` and applies asynchronously, so "a write
re-reads the PR it touched" (spec:128) immediately shows the old head and `mergeable: null`; update-branch on a fork head without "allow edits by
maintainers" is a `422` — forks are in scope (spec:43) and this reason is not among spec:131-132's disabled ones; a merge whose head SHA moved since the
read is a `409`, a branch-protection block a `405`; after a successful merge the re-read PR is closed and must leave the open list; and two tabs merging
the same PR serialise but the second's refusal must read as "already merged", not an error.

Fix: one line per case: what the row shows and whether the action re-enables.

## Minor (file only)

- M1 — spec:93 — "The documented token is Issues read/write + Metadata read": `.env.example:95-99` says "read access to the issues … plus write on
  labels" and "writes nothing else in this phase" (itself stale since task-46). Quote the file, or say "today's docs understate it" and list the full set.
- M2 — spec:91 — `syncOffBlock(path)` is keyed by project PATH (`server/src/tracker/poller.service.ts:523`; `server/src/agents/agents.service.ts:367`), and
  `tracker-sync.json` by repo (`intervalFor(repo)`); PR writes are keyed by repo and "two machines on one repo choose independently"
  (`shared/types.ts:567`). Say the PR write reads `intervalFor(repo) === 'off'` directly and that its serialisation key is `<repo>#<number>`, not an item urn.
- M3 — spec:83 — the guarded set "lives" in `test/agents-origin-guard.test.ts:147-162`; the new routes must be added there or the guard suite does not
  cover them.
- M4 — spec:121 — `unsupported`/`null` projects under a row named "Files" reads close to the invariant "an `unsupported` one never falls back to `files`"
  (`docs/subsystems/invariants.md:2808`). Say explicitly this is display grouping and `ItemsService.writerFor`'s 400 is unchanged.
- M5 — spec:114, spec:119-120 — `login` is read "once per process inside a sweep" (`shared/types.ts:527-529`; `server/src/tracker/poller.service.ts:251-259`),
  and the poller is disarmed with no github project; a token-without-projects shows `token set` only, never the login. Say so.
- M6 — spec:74 — a pre-change `?section=board`/`?section=archive` deep link: `readDeepLink` ignores an unrecognised section (`client/src/lib/deep-link.ts:28`),
  so it opens a plain load, not a blank page; the only external link today is `section=runs` (`server/src/hub/hub-widgets.ts:131`). Worth one sentence so
  nobody builds a migration for it.
- M7 — spec:80 — "CLAUDE.md lists exactly what the server writes" — it enumerates writes to OTHER PEOPLE'S items/issues; the server also writes its own
  settings files (`jira.json`, `tick.json`, `dashboards.json`, `tracker-sync.json`, `timezone.json`). Narrow the sentence.
- M8 — spec:129, spec:131 — merge methods and "auto-merge not enabled on the repo" are `allow_squash_merge`/`allow_merge_commit`/`allow_rebase_merge`/
  `allow_auto_merge` on `GET /repos/{r}`, one more read per repo; name it so the budget in I7 counts it.
- M9 — spec:21 — Jira "unchanged" but spec:123 changes its fall target; say "unchanged save its fall target".
- M10 — spec:111 — docs that name the Trackers card's home follow it: `.env.example:104-110`, `docs/subsystems/board.md`, CLAUDE.md's Layout bullet
  ("plus the `Trackers` card on Shared Settings").
- M11 — spec:29 — `sections.ts`'s comment says "Board's companions first, with Runs seated between Board and Archive" (`client/src/lib/sections.ts:26-28`);
  "work first, Settings last" is a fair paraphrase but not a quote.

## Checked and found true (no finding)

- Rail today is `['board','runs','archive','jira','settings']` (`client/src/lib/sections.ts:34`); Runs is `runs|watchdog|ticks` (`lib/runs-mode.ts:32`); Settings
  scopes `local|shared|dashboards` with rail labels `Local`/`Shared`/`Dashboards` (`SideRail.tsx:395-397`); `FALLBACK_SECTION = 'board'` (`App.tsx:29`);
  the Jira fall is `change('board')` (`App.tsx:181`); `Landing = Section | 'last'` (`lib/settings.ts:35`).
- `BM_GITHUB_TOKEN` in `server/src/tracker/token.util.ts:22`; `GithubClient` talks to one host (`github.client.ts:30`); `isRepo` validates before interpolation.
- The Trackers card holds the platform row (`token set`/`as <login>`, rate limit), per-project sync picker and `connect` command, and the Jira row
  (`TrackersGroup.tsx:47-51, 78-176`) — the split in spec:111-113 matches it.
- Board's project picker is `projectValue === ALL || i.projectPath === projectValue` (`BoardView.tsx:313`); unreachable and `index.errors` warnings are one
  list (`BoardView.tsx:427`).
- No loopback-only write rule exists; the origin guard inherits the Host allowlist (`.claude/rules/security.md`), so spec:97 holds.
- Arming auto-merge has no REST endpoint (GraphQL `enablePullRequestAutoMerge`), and a fine-grained token's permissions cannot be read back — spec:94-95 hold.
