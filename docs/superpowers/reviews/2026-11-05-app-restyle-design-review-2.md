# Review 2 — `docs/superpowers/specs/2026-11-05-app-restyle-design.md` (2026-11-05)

Reviewer: a fresh Fable session with the file paths, the six-point checklist and review 1. Scope: the text changed between `99ac9481` and `259d6e1a`
(`git diff` of the spec), the contradictions those changes create with the rest of the document, and the sibling Jira spec. Review 1's findings are not
re-reported except where the fix is wrong or incomplete. `doc:<line>` is a line in the spec at `259d6e1a`; `file:line` a line in the repo.

## Verdict: APPROVE WITH FIXES

No Critical. Every round-1 finding was addressed, and the new text is right about the code in nearly every place it names it. What remains is one
incomplete fix that leaves two sections contradicting each other, three stated facts that are false, and two places where the new server and shell
behaviour still leaves the implementer guessing.

## What holds (checked, no finding)

- Round-1 Critical fixed: §6 now says "the mark tokens §4.6 lists" (doc:250) and §4.6 names the seven tokens, all in `shared/theme.css`.
- `SplitChip` is menu-less in the Jira spec: its props are `label, labelMore, onMain, onMore, open, disabled, dashed, size, title, icon` and the menu is a
  separate `Popover` named `Run menu` (`2026-11-05-jira-restyle-design.md:81-83,100`). Composers seven today, eight after Move-to (`:59-62`); nine and ten
  here (doc:54-56, doc:297) follow.
- `test/settings-view.test.tsx:86-92` and `:376-382` pin "no in-page switch" (doc:63, doc:291).
- `JiraSessionState` is `starting | plan | permission | reply | answer | working | quiet | lost | ended` (`shared/jira-sessions.ts:7`); `needsYou()` is
  the four amber ones (`:37-39`); `STATE_LABEL` words (`:42-52`) match doc:98-100 and doc:107. Run status is `running | done | aborted | failed | paused`
  (`shared/types.ts:2094`), all five covered at doc:81-83 and doc:141-142.
- Sessions has no `FilterBar` today: two `Select`s, a window `Select` and an `All tickets` `Chip` (`client/src/components/jira/JiraSessionList.tsx:114-134`).
- Windows are `24h | 7d | 30d | all`, labels `24 h`, `7 d`, `30 d`, `All` (`client/src/lib/jira-list.ts:35-40`); `JiraSessionsView` receives
  `onOpenJiraPage: (p: JiraPage) => void` (`JiraSessionsView.tsx:32-37`).
- The session row carries `contextPct` and no cost (`JiraSessionList.tsx:256`).
- `Make default` writes `jiraDefaultAction`, the per-browser setting Settings › Local writes (`SettingsView.tsx:550-556`).
- Deck card: Unlink only for a `branch` link, Stop only with `stopState` (`JiraSessionCard.tsx:49-56`).
- `RunControls` is Pause / Cancel / Stop / Resume (`client/src/components/RunControls.tsx:14`).
- `checks` is `success | failure | pending | none | unknown` (`shared/types.ts:630`). Auto-merge is a toggle posting `enable: false` while armed
  (`client/src/components/github/PrActions.tsx:36,78`).
- Jira serves `me.name` / `me.accountId` only; GitHub serves `login` (review 1's cites, unchanged).
- `PullRequestsService` has no timer; the "nothing reads pull requests except the PRs page" reason is in its header (`server/src/tracker/pulls.service.ts:26-33`)
  and in `.claude/rules/tracker.md:108-110`; TTL and one in-flight read per repo (`pulls.service.ts:37-40`, `tracker.md:110`).
- `test/run-pulse.test.ts:73-78` `VIEWS` are Archive, Board, PRs, Runs; `:83-86` bars `App`.
- Scope pill words today are `this browser` / `this machine` (`SettingsView.tsx:159`); the Dashboards list's `this machine` is Home (`DashboardsList.tsx:45`),
  which is the server's host, so doc:215-216 holds.
- `SameOriginPostGuard` is on every POST controller the sweep routes would join (`server/src/tracker/tracker.controller.ts`, `pulls.controller.ts`,
  `jira/jira-write.controller.ts`).
- Jira: the 429 window is `JiraBootState.retryAt`, the sweep makes no call inside it and a route is refused up front with the stored instant
  (`server/src/jira/poller.service.ts:70-76,146-150,601`); `unknown board` 404 (`jira.controller.ts:105,108`; `.claude/rules/jira.md:21`); `armed` is
  "a timer is scheduled" (`jira/poller.service.ts:226-228`); a sweep failure keeps the last list with `access` / `detail` (`:63-69`).
- `JIRA_POLL_MS = 15_000` (review 1) — "the 15 s tick" at doc:243.

## Critical

None.

## Important

- **[I] doc:107-108 vs doc:255 — the Cost-column fix is half applied, and the two sections now contradict each other.** §4.3 says "The Cost column is not
  built: the session row carries `contextPct` and no cost"; §6 still says "The Cost column on Sessions is built only if the data is already served (§4.3)".
  The code agrees with §4.3 (`client/src/components/jira/JiraSessionList.tsx:256` reads `sessionRow?.contextPct`; nothing on the row is a cost).
  → Rewrite doc:255 to "The Cost column on Sessions is not built: no cost is served (§4.3)".

- **[I] doc:122-123 — "its title says `default in this browser`" names copy that does not exist.** The Settings › Local row is `name="Jira default action"`
  with the hint "Listed first in a Jira card's Run menu, marked default. A skill that has since been deleted reads as Work it end to end."
  (`client/src/components/settings/SettingsView.tsx:544-546`); `grep -rn "in this browser" client/src` hits only the page blurb at `:190` and a comment at
  `:238`. An implementer looking for that title to cross-reference will not find it. → Quote the row by its real name (`Jira default action`), and if the
  hint should say the setting is per browser, state that as a copy change in §4.10.

- **[I] doc:204-209 — the runs context moves `useOrchestratorRuns()` into one provider but says nothing about `useReportWorking`, which the same guard
  pins.** `test/run-pulse.test.ts:88-92` asserts that each of the four `VIEWS` calls `useReportWorking(`, and `App` holds only the `working` boolean the
  views report up (`:64-67`). Once the provider owns the one poll, either the views keep calling `useReportWorking` against context data (two sources of one
  reading) or the provider derives `working` itself and the four `useReportWorking` calls and that assertion go. The spec names only the caller-list and the
  `App`-bar assertions. → Say which: recommended, the provider computes `working` (`runsWorking`) and the shell reads it from the context; the
  `useReportWorking` plumbing and `run-pulse.test.ts:88-92` leave in the same commit, with this section as the reason.

- **[I] doc:240-241, doc:289-290 — the 429 answer is written for Jira and does not fit GitHub.** Jira has one stored window, `retryAt`, and an existing
  up-front refusal (`server/src/jira/poller.service.ts:70-76`). The tracker has neither: its sleeps are per repo and in two pools — `sleepUntil` (REST hourly
  reset or secondary back-off) and `secondaryUntil` (GraphQL, which the PR re-read uses) — read by `asleep()` (`server/src/tracker/poller.service.ts:1115-1118`),
  and a timed sweep simply skips an asleep repo (`:826`), it refuses nothing. So for `POST /api/github/sweep`: which pool's end is "its sleep's end"; is a
  sweep with no `repo` a 429 when one repo of several is asleep, or a 200 that skips it (as the timed sweep does) with that repo's `access: 'rate-limited'`;
  and does a GraphQL (`secondaryUntil`) sleep block the issue sweep or only the PR re-read? §8's "inside a 429 window the answer is 429 with the stored
  `retryAt`" cannot be written as one test for both services. → Specify GitHub separately: recommended, a sweep with `repo` is a 429 carrying
  `max(sleepUntil, secondaryUntil)` when `asleep(state)`; a sweep with no `repo` runs as the timed sweep does (asleep repos skipped, reported through their
  `access` / `detail`) and answers 200; and the §8 case names the two fields.

- **[I] doc:276-277 — the test inventory names cases that do not exist.** `test/rail.test.tsx` has no case that clicks the `All tickets` chip: its one
  mention is the title of the case at `:640`, which clicks the rail badge `1 session needs you` and asserts the filters it set. No case in
  `test/jira-list.test.tsx` picks from the Repository / Run / window selects: the window is set programmatically (`setJiraListFilters({ window: 'all' })`,
  `:228`). The cases that do need the popover are `jira-list.test.tsx:271` and `:361` (click `All tickets`) and `:420` (asserts the `All tickets` button in
  the no-boards empty state). → Name those three and drop `rail.test.tsx` and the selects from the sentence.

- **[I] doc:239-240 — "a 404 `unknown repo` (the repo convention)" names a convention that does not exist.** `unknown board` / `unknown skill` is the Jira
  config convention (`.claude/rules/jira.md:21`); the PR writes' 404 for a repo no registered project resolves to reads
  `` `${repo} is not the repo of a registered GitHub project` `` (`server/src/tracker/pulls.service.ts:325`; `.claude/rules/tracker.md:136`). → Either reuse
  that text and cite it, or say `unknown repo` is new text chosen to mirror Jira's.

## Minor

- doc:200-203 — "shared with the PRs page so one tab makes one read a minute": `useCoalescedFetch` coalesces in-flight calls for ONE hook instance
  (`client/src/hooks/useCoalescedFetch.ts:6-13,23`); `PullRequestsView` and `GithubAccessGroup` each own a poll today. Sharing needs a context like the Runs
  one at doc:204; one clause saying so saves the implementer the same discovery §4.9a already made for runs.
- doc:109-110 — the mock's empty-state title is `No sessions on Globals this week` (`2026-11-05-jira-restyle-mockups/JiraSessions.dc.html`); the spec's
  `… 7 days` is a deliberate change that §6 does not list, unlike `Review plan` and `Squash and merge`.
- doc:235 — "A poller that is not armed answers 409": Jira's handler ladder is guard → validate (400) → configured (503) (`.claude/rules/jira.md:21`), and a
  not-configured Jira is also not armed. Say 503 when not configured and 409 only when configured yet disarmed (every board `off`), so the two routes do not
  invent a second answer for the same state.
- doc:233 — no `/api/github/*` route exists today (`@Controller` paths: `api` for `TrackerController`, `api/prs`, `api/trackers`); say whether the sweep
  joins `TrackerController` (`server/src/tracker/tracker.controller.ts:32`) or opens a controller.
- doc:239 — "re-reads the PR cache … once, past its TTL": say "as if past its TTL" (a forced re-read) — as written it can be read as "only when past its TTL".
- doc:36, doc:148 — `Cancel` is the cancel-pause control (`cancelPauseOrchestrate`, `client/src/components/RunControls.tsx:4`); `Cancel pause` would keep
  the non-goal list readable without the code.
