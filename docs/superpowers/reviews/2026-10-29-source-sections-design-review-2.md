# Review 2 — Source sections: Files, GitHub and Jira at the rail's root

Document: `docs/superpowers/specs/2026-10-29-source-sections-design.md` (180 lines, at `88ff8a3`). Reviewer: fresh subagent (Fable), checklist as dispatched.
Round 1's report is `2026-10-29-source-sections-design-review-1.md`; the changes since are `git diff HEAD~1 -- docs/superpowers/specs/`. Every claim below
was checked against the worktree at `88ff8a3`; `file:line` cites are to that tree.

## Verdict: APPROVE WITH FIXES

No Critical. Six Important — two false statements about the code that would make the run-in-progress chip wrong on every tracker PR (I-A, I-B), one
clause that would create a second home of a sentence a `.claude/rules/` bullet pins to one (I-C), two places where the implementer must guess (I-D, I-F),
and one sentence about a deep link that does not exist (I-E). Every fix is a sentence or two; nothing questions the decisions. Round 1's one Critical and
eight Important are resolved (ledger below); one round-1 Minor was not taken and is carried.

## Round-1 ledger

| Round 1 | Status | Where |
| --- | --- | --- |
| C1 — rules bullet missing from the write invariant's change set | Resolved | spec:89-92 names `.claude/rules/tracker.md`, three byte-equal homes, the tier test |
| I1 — sync-off sentence names the card's old home | Resolved | spec:115-118: new sentence, server literal, client copy, five suites, `.env.example` |
| I2 — Files draw rule stated two ways | Resolved | spec:44-45 now counts `unsupported`/`null` |
| I3 — no named answer / no unknown branch for Files and GitHub | Resolved | spec:33-37: `GET /api/projects`, one provider, three states |
| I4 — stored `board` on an empty machine lands on an undrawn row | Resolved | spec:150-153: provisional `github`, settled on first answer, else Fallback |
| I5 — Sources card links vs the tree rule | Resolved (precedent misnamed, M-a) | spec:133-135 |
| I6 — PR head → run/claim rule missing | Partly: rule given, but on a false premise and the wrong id shape | spec:49-53 → I-A, I-B |
| I7 — cache vs per-request, cadence, read shape | Resolved (one attribution wrong, I-F) | spec:99-101, 155-161 |
| I8 — write failure/timing cases | Resolved | spec:162-171 |
| M1–M10 | Resolved | spec:106, 103-105, 142-143, 144-145, 146, 88, 158, 21, 147 |
| M11 — `sections.ts` comment paraphrased as a quote | Not taken | spec:29 → M-e |

## Important

### I-A — spec:50 — "Run files carry no PR branch" is false; in PR mode the run file's `base` IS the PR's head

`orchestrate.mjs init` writes `base: runBranch ?? base, prTarget: runBranch === null ? null : base` (`skills/backlog-orchestrate/tools/orchestrate.mjs:3575-3576`;
`prTarget` on the run shape at `shared/types.ts:1932`). Under `pr` the run file's `base` is exactly `backlog/run-<date>-<n>`, the branch the run's PR is
opened from. The spec builds the `backlog/run-*` arm of the chip on the premise that nothing names it, and so matches by PREFIX ("warned while that repo's
run is live or paused"): an open PR left by an EARLIER pr-mode run on the same repo — which is the normal state of a repo whose last run's PR is still
waiting for a person — would be warned the moment any later run on that repo starts, and the chip would be wrong for exactly the PR the page exists to
manage.

Fix: strike "Run files carry no PR branch" and state the arm as: a head equal to a live or paused run's `base` (which under `pr` is the run branch) is
warned; any other `backlog/run-*` head is not.

### I-B — spec:51 — `backlog/<id>` / `execute/<id>` "name an item", but on a GitHub project the id in the branch and the id on the board are spelled differently

Inside a run a tracker item's id is the bare issue number — "The bare issue number is the id INSIDE a run, and `#31` is the id [on the board]"
(`skills/backlog-orchestrate/tools/orchestrate.mjs:2071, 2105-2129`); the item branch is `backlog/${itemId}` (`:4311, 4544, 4690`), so `backlog/31`.
Execute's is `execute/${executeId(id)}` with `executeId = (id) => id.replace(/^#/, '')` (`skills/backlog-tick/tools/tick.mjs:233, 560`), so `execute/31`.
The board's item id, the claim's key and `isItemId`'s tracker shape are `#31` (`shared/agent.ts:722`). GitHub › PRs lists GitHub projects ONLY (spec:55), so
every PR the chip can see is of this shape, and a lib function that compares `<id>` to `BacklogItem.id` as written never warns anything.

Fix: say the `<id>` in both heads is the bare issue number, and the function compares it to the run's item ids as recorded (bare), and to `#<id>` for a
starting entry's ids and a live claim.

### I-C — spec:102 vs spec:104 vs `.claude/rules/tracker.md:106-107` — "reads `intervalFor(repo) === 'off'` directly" makes a second home of a sentence the rule pins to one

The rules bullet reads: "`TrackerPollerService.syncOffBlock(path)` is the ONE server home of the sentence `sync is off for <owner/name> — turn it on in …`"
(`.claude/rules/tracker.md:106-107`; the literal at `server/src/tracker/poller.service.ts:518-523`). spec:102 says PR writes "go through `syncOffBlock`";
spec:104 says, because it is keyed by project path, "a PR write reads `intervalFor(repo) === 'off'` directly". Taken as written, the refusal either
re-types the sentence beside a direct `intervalFor` read (a second server home, which the bullet forbids) or refuses with a different sentence (a copy the
client's `lib/tracker.ts:253` twin and the five suites would then not pin). Both sentences cannot stand.

Fix: pick one and say it: resolve the repo to its registered project's path (one registered GitHub project per repo on this machine) and call
`syncOffBlock(path)`; or give `syncOffBlock` a repo-keyed entry inside the same method and extend the rules bullet to say so. Either way, the new
sentence of spec:118 stays in that one home.

### I-D — spec:148 vs spec:150 — `FALLBACK_SECTION` is a compile-time constant consumed before any answer exists, but spec:148 gives it a runtime value

`FALLBACK_SECTION: Section = 'board'` (`client/src/App.tsx:29`) is returned by `resolveSection` for every unrecognised value (`:61-62`), is the
`usePersistedState` default (`:91`) and seeds the `useState` initializer (`:115`) — all before `GET /api/projects` has answered. spec:150 acknowledges
this for a stored LEGACY `board`/`archive` ("maps … to `github` provisionally … on the FIRST projects answer the shell settles it") but spec:148 says
`FALLBACK_SECTION` itself "go[es] to the first drawn source row (Files, then GitHub), else Runs", which cannot be computed where it is read. An
implementer must guess what the constant becomes and whether an unrecognised stored value (not `board`/`archive`) is settled the same way.

Fix: state the constant (`github`, provisional, or `runs`) and that EVERY provisional landing — legacy `board`/`archive` and any unrecognised value — is
settled by the same first-answer step; the Jira fall (`change('board')`, `App.tsx:181`) then targets the settled value's rule, not the constant.

### I-E — spec:153 — "A deep link to an item" describes a link this app does not have

`readDeepLink` reads exactly three params, `section`, `runs`, `settings` (`client/src/lib/deep-link.ts:22-32`); `App` calls it once on
`window.location.search` (`client/src/App.tsx:111`); the only link anything external emits is `/?section=runs&runs=history`
(`server/src/hub/hub-widgets.ts:131`). There is no item parameter anywhere in `client/src`. The sentence tells the implementer to resolve a deep link that
cannot arrive, and reads as a new feature smuggled past the Non-goals.

Fix: drop the sentence, or move "item deep links" to Non-goals.

### I-F — spec:159-160 — "the same rate-limit handling" is attributed to `GithubClient`, which has none; the sleep lives in the poller's per-repo state

`GithubClient` returns the limit as VALUES — `retryAfter`, `secondary`, `rate` on every response (`server/src/tracker/github.client.ts:325-353`) — and never
sleeps. The sleep is `TrackerPollerService.handleFailure`: a secondary limit or a 403/429 with `remaining: 0`/`Retry-After` sets `state.sleepUntil` on
that repo's `RepoState` (`server/src/tracker/poller.service.ts:927-950`; `RepoState.sleepUntil` at `:232`), and `syncRepo` makes no request while it is set
(`:677-682`). The PR cache is a separate per-repo cache (spec:155), so "under the same rate-limit handling" leaves the implementer to decide whether a
rate-limited PR read sets a `sleepUntil` of its own, shares the poller's `RepoState`, and whether an asleep issues sweep also silences the PR read.
GitHub's GraphQL primary limit is a separate pool from REST's (secondary limits are shared), so sharing one `sleepUntil` across both would sleep a read
that is not limited.

Fix: one sentence — the PR cache keeps its own per-repo `sleepUntil`, set from the GraphQL answer's `retryAfter`/`rate` by the same rule as
`handleFailure`, rendered as the row's `detail`, and a secondary-limit answer on either read sleeps both — or whatever the author prefers, stated.

## Minor (file only)

- M-a — spec:134 — "the Board's `Set up` chip": the chip is the Jira board's empty-state `Open Setup` (`client/src/components/jira/JiraBoardView.tsx:165`;
  `.claude/rules/board.md:61` names `Open board` and `Open Setup`); the main Board has no such chip. Name the precedent as it is.
- M-b — spec:157 — the GraphQL field list omits `maintainerCanModify` (and `isCrossRepository`/`headRepository`), which spec:164-165's "disabled with
  `fork does not allow edits` when the read says so" needs. Add them so the one-query budget counts them.
- M-c — spec:162 vs spec:166 — "the row re-reads after every outcome" and "`409` also re-reads": the "also" implies the others do not. Drop it.
- M-d — spec:174-175 — the disabled-reason list (draft, checks failing, not mergeable, already up to date, auto-merge not enabled) omits `sync off` (spec:103)
  and `fork does not allow edits` (spec:165). Say "among them" or list all seven, so the copy has one home.
- M-e — spec:29 (round 1's M11, carried) — `sections.ts`'s comment says "Board's companions first, with Runs seated between Board and Archive rather than
  after Settings" (`client/src/lib/sections.ts:26-28`); "work first, Settings last" is a paraphrase in quotation marks.
- M-f — spec:155, spec:160 — a 60 s client poll against a 60 s server TTL: a poll landing a few ms under the TTL is served the old entry and the next
  re-read is a poll later, so the page can show data up to ~120 s old while reporting a `polledAt` that says so. Fine if intended; one clause ("the TTL is
  shorter than the client's interval" or "two minutes is acceptable") saves the implementer a guess.
- M-g — spec:112-113 — "the Jira Setup page is the precedent": the invariant entry (`docs/subsystems/invariants.md:3206-3240`) does not name Jira Setup; the
  rewritten entry should, since the spec leans on it.

## Checked and found true (no finding)

- `GET /api/projects` is `items.controller.ts:21`; `ProjectSummary.source` is `SourceKind | 'unsupported' | null`, `null` exactly when `missing`
  (`shared/types.ts:412-441`); `useTrackers` fetches once with no syncing GitHub row (`client/src/hooks/useTrackers.ts` header, "No timer at all…").
- The three states at spec:36-37 match the Jira rule as written (`.claude/rules/board.md:54-58`; `App.tsx:164-182`).
- `.claude/rules/` has `tracker.md` and `board.md`; `board.md` holds both the Settings headline (`:47`) and the Jira tree rule (`:54`); the tier test holds tier
  one and two to one multiset (`test/claude-rules.test.ts:16-17`).
- The sync-off literal: `poller.service.ts:523`, copy `client/src/lib/tracker.ts:253`, pinned by exactly the five suites named (`grep -l` over `test/`);
  `.env.example:104, 108` name the Trackers card.
- The guarded set lives in `test/agents-origin-guard.test.ts:147-171`; eleven `/api/items/*` routes are in it.
- `useCoalescedFetch(task, { armed, intervalMs })` is a fixed interval (`client/src/hooks/useCoalescedFetch.ts:23-24`).
- `readDeepLink` ignores an unknown section (`deep-link.ts:27`); `Landing = Section | 'last'` (`lib/settings.ts:35`); `landingOptions` is per configured
  source already (`SettingsView.tsx:90`).
- `ItemsService.writerFor` refuses `unsupported` (`server/src/items/items.service.ts:325-330`); `ItemsIndex.errors` carries the marker's reason
  (`shared/types.ts:382, 430`).
- `GET /api/jira` carries `site` and `boards` (`shared/types.ts:808-812`); `TrackersPayload.projects[].access` is per repo (`poller.service.ts:500-506`); the
  login is read inside a sweep and the poller is disarmed with no connected repo (`:559, :646`).
- `GithubClient` is REST-only on one host (`github.client.ts:30`); GitHub's update-branch answers `202`, merge `405`/`409`, auto-merge arms through GraphQL
  only; a fine-grained token's write permissions cannot be read back.
- `.env.example:95-99` understates the token ("plus write on labels … writes nothing else in this phase") — spec:106 now says so.
