# Review 1 — `docs/superpowers/specs/2026-11-05-app-restyle-design.md` (2026-11-05)

Reviewer: a fresh Fable session with only the file paths and the six-point checklist. Every claim below was checked against the code by narrow reads;
`doc:<line>` is a line in the spec, `file:line` a line in the repo. The companion Jira spec (`2026-11-05-jira-restyle-design.md`) and
`00-mock-audit.md` were read in full; the mocks were grepped for every copy string the spec quotes or overrides.

## Verdict: REVISE

One Critical (the spec contradicts itself on stage tokens, and the losing side would ship new theme tokens against its own non-goal) and a run of
Importants where a stated fact is false or an implementer must guess. Nothing here is hard to fix; most are one-sentence decisions.

## What holds (checked, no finding)

- Popover composer count seven today, DIALOG count eight: `.claude/rules/board.md:20`, `client/src/hooks/useDialogEscape.ts:47`,
  `test/dialog-count-docs.test.ts:87-94`.
- `test/run-pulse.test.ts:83-86` pins the four `useOrchestratorRuns()` callers and bars `App`; the shell holds only `working` (`client/src/App.tsx:203-204`).
- `state.json`'s `recent` keeps 50 (`skills/backlog-tick/tools/tick-state.mjs:18,212`), served newest first (`server/src/tick/tick.service.ts:155`,
  `shared/types.ts:2851`); outcomes are exactly `ok` | `failed` (`tick-state.mjs:172`).
- `.rail-kicker` is the one uppercase rule (`client/src/styles.css:162-166`, `test/design-guards.test.ts:211-213`).
- Every token §4.6 names exists in `shared/theme.css` (`--green-solid:82`, `--cyan:32`, `--amber-solid:83`, `--magenta:39`, `--mustard:31`, `--ink3:28`,
  `--steel:21`); `MACHINE_STAGES` is preflight + the six pipeline stages (`client/src/lib/run-stats.ts:230`, `shared/types.ts:1679`).
- `JiraIssueList` columns (`client/src/components/jira/JiraIssueList.tsx:47-54`); `tokenKind`, `calls.sweep`, `last429At` served (`shared/types.ts:1034-1046`);
  scopes are not served (`JiraConnectionGroup.tsx:15-16`).
- `JiraWorktreeRow`'s `Remove` copies `removeCommand` and runs nothing (`client/src/components/jira/JiraWorktreeRow.tsx:14-19`); `JiraReposGroup` already
  lists a path's worktrees under its row (`JiraReposGroup.tsx:40-43,298-303`).
- Launch sheet: `Open in` is Dashboard | Desktop and drawn only while the dashboard offers desktop (`JiraLaunchSheet.tsx:72-74,116`); `Assign to me`,
  `Move to`, Model/Effort, Remote control switch (`:68-69,107-111,402`).
- Deck card: `contextPct` (`JiraSessionCard.tsx:156`); Stop and Unlink with their conditions (`:49-56,198-202`); `Stop session` already confirms (`:259-282`).
- Watchdog: `nextTickAt` (`shared/types.ts:2778`), no checked-at served, policy names (`WatchdogGroup.tsx:283-309`), `WATCHDOG_EVENT_CAP = 50`
  (`shared/types.ts:2719`). Ticks: the pink fill is `.tick-row-halted` (`client/src/styles.css:2309`, `TickMonitor.tsx:212`), Reset is the page's one write.
- PRs: triage words (`client/src/lib/pr-layouts.ts:25-32`); `aria-disabled` + `aria-describedby` (`PrActions.tsx:125-126`); `PR_KEYS` four
  (`client/src/lib/prs.ts:144`); `MATRIX_COLUMNS` five plus Updated (`pr-layouts.ts:299`, `PrMatrix.tsx:74`); the method `Select` in the Confirm
  (`PrFoot.tsx:86`); the PR poll is 60 s and runs only where `usePullRequests()` is called — `PullRequestsView` and `GithubAccessGroup`
  (`client/src/hooks/usePullRequests.ts:13`).
- Shell: cursor (`SideRail.tsx:169`), `rail-badge` (`:212`), `aria-current="page"` (`:198`), the releases chip and dot (`:66,297-304`); `TrackerChip` and
  `JiraChip` draw `Meter`s (`TrackerChip.tsx:81-82`, `JiraChip.tsx:76-77`); GitHub serves `login`, `limit`, `remaining` (`shared/types.ts:533-537`).
- Settings: three pages, scope pill (`SettingsView.tsx:107,159`); Local rows (`:276-338,410,428`); `MergeMode` is `merge | branch | pr`
  (`shared/types.ts:1542`); Watchdog `Enabled` switch + three numbers; Tick three numbers (`TickGroup.tsx:72-105`); Dashboards list in prefer order with
  account pill and two meters (`DashboardsList.tsx:12-13,45-62`), `usageTone` already exists; `POST /api/dashboards/settings` writes the order
  (`server/src/agents/dashboards/dashboards.controller.ts:76`, `dashboards.service.ts:61,106`).
- `POST /api/trackers/sync` exists and writes a repo's sync interval (`server/src/orchestrator/tracker-sync.controller.ts:14,30,46`).
- The tracker poller's `armed` is "a timer is scheduled" (`server/src/tracker/poller.service.ts:406`); Jira's the same shape with `JIRA_POLL_MS = 15_000`
  (`server/src/jira/poller.service.ts:117`) and an existing force-a-board-now primitive, `boardSaved` (`:91-103`).
- Mocks: every string the spec quotes from a mock is in that mock (`No sessions on Globals this week`, `Show 30 days`, `Go to the board`, `Review plan`,
  `4322`, `API connected`, `2 need you`, `Sync now`, the three merge-mode labels, the three action tiles, `Terminal`, `Starts in microservice on a new
  worktree`, `Squash and merge`, `Blocked`, `checked 12 s ago`, `Idle · nothing to watch`, `#5c9a2e`/`#e9a24f`, `Connected as …`, `Healthy`, `(default)`,
  `Open worktrees beside this checkout`, `Not prioritised`, `Showing 3 of 6`, `Clear`).

## Critical

- **[C] doc:135 vs doc:230 — the spec contradicts itself on stage tokens.** §4.6 says "No stage tokens exist and none are added: the segments use the
  existing mark tokens"; §6 says "the build uses stage tokens and each theme's own tokens". An implementer reading §6 (the section that says what replaces
  the mock's hex) adds `--stage-*` tokens, which breaks the non-goal at doc:41 ("No new theme tokens") and the Jira spec §3's tint-form guard
  (`test/daylight-contrast.test.ts:393-411` pins every tint's hue to the six mark tokens). → Rewrite doc:230 to "the build uses the mark tokens §4.6 lists
  and each theme's own tokens".

## Important

- **[I] doc:62, doc:254 — Sessions does not use `FilterBar` today.** `<FilterBar` is composed by `client/src/components/archive/ArchiveView.tsx`,
  `board/BoardView.tsx` and `jira/JiraBoardView.tsx` only; `JiraSessionList` draws two `Select`s and an `All tickets` `Chip`
  (`client/src/components/jira/JiraSessionList.tsx:116-132`). So "existing FilterBar tests keep passing (… Sessions)" names tests that do not exist, and §4.3
  is adding a FilterBar composer, not restyling one. → Strike Sessions from both lists; in §4.3 say Sessions GAINS `FilterBar` (its own `Popover` mount, not
  a new `Popover` composer per `board.md:22`), and in §8 name the Sessions tests that pin the two selects.
- **[I] doc:75, doc:81-82 — "the deck's state word" is not `Needs you · plan`.** The deck's words are `STATE_LABEL` — `Waiting for plan approval`,
  `Waiting for permission`, `Waiting for a reply`, `Waiting on your answer`, `Working`, `Quiet`, `Lost contact`, `Ended`, `Starting…`
  (`shared/jira-sessions.ts:41-50`, "spec §6 verbatim"), pinned by `test/jira-sessions-state.test.ts`. No `Needs you` word exists on the deck. → Decide:
  either the labels change to `Needs you · <phase>` everywhere (deck, Detail, List, Sessions, and that test moves, with the phase word per state), or the
  List and Sessions cells read today's labels and the mock's `Needs you · plan` joins §6.
- **[I] doc:60-61 — the state stripe's four tones do not cover the session states.** `JiraSessionState` is `starting | plan | permission | reply | answer |
  working | quiet | lost | ended` (`shared/jira-sessions.ts:7`); there is no `failed`, and `starting`, `quiet` and `lost` have no tone in the list. → Give the
  map per state (and per run status for the live run cards), e.g. `needsYou()` states amber, `working`/`starting` green, `quiet`/`lost` ?, `ended` grey.
- **[I] doc:89, doc:181 — "avatar" is not served by either service.** Jira's status payload carries only `me.name` and `me.accountId` — "the only identity
  facts that leave the server" (`shared/types.ts:1026,1033`); the tracker carries `login` (`shared/types.ts:533`). §5 (doc:225) lists what the mocks drew
  that is not served and omits the avatar. → Say the head draws the Jira spec's 22 px initials disc from the name/login, and add "avatar" to doc:225.
- **[I] doc:222 — "when the PR poll is armed" has no server meaning.** `PullRequestsService` has no timer, interval or sweep; a read happens only inside
  `GET /api/prs` or a write's re-read (`server/src/tracker/pulls.service.ts:28-32`; `.claude/rules/tracker.md:109-110`). The 60 s poll is the browser's
  `useCoalescedFetch`, which the server cannot see. → Either the GitHub sweep refreshes (or just expires) the PR cache for every connected repo
  unconditionally, or it never touches it; and if it does, name `tracker.md`'s PR-cache bullet and `pulls.service.ts`'s "why no timer" comment as moving in
  the same commit.
- **[I] doc:190-191 — the always-on PR poll overturns a documented premise without naming it.** `pulls.service.ts:28-30` and `tracker.md:109-110` rest on
  "nothing reads pull requests except the PRs page, so a sweep would spend GraphQL budget on a list nobody is drawing". §4.9a makes every open tab read them
  every 60 s. The invariant's letter ("a read happens only inside `GET /api/prs`") survives; its reason does not. → Add the comment and the rule bullet to
  the "moves in the same commit with the reason" list, as §3 already does for `run-pulse`.
- **[I] doc:192-194 — "never two" is only true on the Runs page.** Board, Archive and PRs each call `useOrchestratorRuns()` as their own 5 s poller
  (`test/run-pulse.test.ts:72-77`, `client/src/hooks/useOrchestratorRuns.ts:23`); with an always-on shell context, those three pages run two polls. → State
  that all four views read the shared context (and `useReportWorking` goes), or state that the second poll on those pages is accepted and why.
- **[I] doc:139 and doc:36 — `RunControls` draws Pause / Cancel / Stop / Resume, not "Resume, Stop".** `client/src/components/RunControls.tsx:14,219-220`.
  Pause and Cancel are in neither §4.6's head nor the non-goal list of actions that keep their behaviour. → List all four in both places.
- **[I] doc:217-223 — the sweep routes' failure answers are unspecified.** A Jira read inside a 429 window is refused up front with a synthesised 429
  carrying the stored instant (`server/src/jira/poller.service.ts:70-74`); a 401/5xx sweep keeps the last cache. The spec says the route "returns when it has
  finished, with the new cache ages" and nothing about these. Every Jira POST also runs `SameOriginPostGuard` first (`.claude/rules/jira.md:21`), which the
  spec does not name. → State the guard, and the answer per failure (e.g. 200 with the unchanged ages plus `access`/`retryAt`, the shape `GET /api/jira`
  already carries), and what `Sync now` shows for each.
- **[I] doc:95-96 — `Make default` on Jira › Setup writes a Local (per-browser) setting from a `this machine` page.** The default action is
  `settings.jiraDefaultAction`, per device (`client/src/lib/settings.ts:189,195,223`), written by Settings › Local (`SettingsView.tsx:550-556`); Setup is
  the server's `jira.json` (`JiraSetupView.tsx:21`). → Say which store `Make default` writes and whether the Local row stays, or drop the control and keep
  the `default` mark read-only.
- **[I] doc:84 — the empty-state title names the window, but only `this week` is given.** The windows are 24 h / 7 d / 30 d / All
  (`client/src/lib/jira-list.ts:35-40`). → Give the phrase for each (`today`, `this week`, `this month`, `ever`, or whatever is chosen).
- **[I] doc:133 — the Runs breakdown "done / aborted / failed / live" leaves `paused` unassigned.** Run status is `running | done | aborted | failed |
  paused` (`shared/types.ts:2094`). → Say paused counts as live (or is its own segment).
- **[I] doc:155-156 — the status tile's three states do not map onto the row's facts.** `checks` is `success | failure | pending | none | unknown`
  (`shared/types.ts:630`), and the row's problems also include conflicts, changes requested and behind base (`client/src/lib/prs.ts:74-83`). "green ready"
  is not a checks state. → Define the tile as the triage level (needs-you red, worth-a-look amber, quiet green) or as the checks state with the
  `none`/`unknown` case named.
- **[I] doc:160 — with auto-merge armed, the main half's click is unspecified.** The main half "merges, or enables auto-merge while checks are still
  running"; when armed it reads `Auto-merge on` — does a click merge, disarm, or nothing? Today the key is a toggle (`PrActions.tsx:71,85-88`). → Say what
  the main half does in the armed state (and whether it is `aria-disabled`).
- **[I] doc:43-44, doc:199 — the Settings in-page switch is pinned by a test the spec does not name.** `board.md:47` is the rule; `test/settings-view.test.tsx:90-91`
  and `:376-379` ("No in-page switch, at any width — the rail's tree is the only thing that…") assert it. §8 lists no Settings test change for it. → Add
  the test to §8 with the override reason, beside the `board.md` and DESIGN §8.6 edits.
- **[I] doc:199-200 — "this server" for the Shared scope collides with Jira › Setup's "this machine" for the same scope.** Today Settings says
  `this browser` / `this machine` (`SettingsView.tsx:159`) and Setup's band says `this machine` for the server's `jira.json` (`JiraSetupView.tsx:21,135`).
  After the restyle one server-side scope would read `this server` on Settings and `this machine` on Setup, while `this machine` on the Dashboards list
  means Home. → Pick one word for the server scope across Settings and Setup, and say which.
- **[I] doc:35-37 — "unless `SplitChip` owns the menu's `Popover`" reopens the Jira spec's primitive.** The Jira spec §4.1 fixes `SplitChip`'s props
  (`label, labelMore, onMain, onMore, open, disabled, dashed, size, title, icon`) with the menu owned by `JiraRunMenu`, not the primitive. Leaving this open
  here means two specs disagree on the primitive's contract, and the plan cannot state the composer count. → Decide here: `SplitChip` stays menu-less (then
  the count is ten: Merge menu and deck Open menu are composers nine and ten), or amend the Jira spec.
- **[I] doc:266-267 — "an unknown `boardId` … is a 400" is the wrong status by this repo's convention.** An id the file does not hold is a 404
  `unknown board` (`.claude/rules/jira.md:20-21`). → 404 for an unknown board id; keep 400 for a malformed body.

## Minor

- doc:85 — `Go to the board` is an in-page control that switches a Jira page; `board.md:56` allows only "a link threaded down from" the rail.
  `JiraSessionsView` already receives `onOpenJiraPage` (`JiraSessionsView.tsx:32-37`); say the button uses it.
- doc:83 / doc:235 — the Cost column's condition is checkable now: the session row carries `contextPct` and no cost (`JiraSessionCard.tsx:156`;
  `JiraSessionList.tsx:155-164`). Say "not built" rather than deferring the check.
- doc:128 — the deck card's chevron menu may be empty: Unlink is drawn only for a `branch` link, Stop only with `stopState` (`JiraSessionCard.tsx:49-56`).
  Say what the chevron does with no rows (disabled, or the split collapses to one button).
- doc:147 — the policy figure reads "Leave a resumed run alone"; the Settings row is "Leave a resumed run alone for" (`WatchdogGroup.tsx:296`) and the
  two mocks differ the same way (RunsOps vs SettingsMore). Pick one.
- doc:166-167 — "a repository that could not be read is one line under the cards, not a red card" is today's behaviour already (`PrCards.tsx:95-96`);
  say "as today".
- doc:177-179 — which read the footer dot follows is a behaviour decision sitting in §4; move it to §7 or decide it.
- doc:205 / doc:224 — the Files row's `Open` has no threaded pair on `SourcesGroup` (`SourcesGroup.tsx:35` takes only the GitHub and Jira pairs); and "the
  newest age when all three answer" — the Files/registry read has no served age to show. Say what `Last read` reads for Files.
- doc:211-212 — the write exists: `POST /api/dashboards/settings` carries `order` (`dashboards.controller.ts:76`, `dashboards.service.ts:106`). Drop the
  conditional.
- doc:219 — "joins it rather than starting another" differs from the existing primitive, which waits the in-flight sweep out and runs one that started
  after the call (`poller.service.ts:103`). A joined sweep may predate the click; say that is accepted.
- doc:222-223 — a repo on `off` is skipped and the row's icon disabled; what colour is the service pill when every repo is `off` and the poller has
  disarmed (`tracker.md:77-78`)? Probably grey; say so.
- doc:73-74 — the List draws `Not prioritised` grey for a null priority while the Jira spec §4.2 draws nothing on the card for `null`. Different surfaces,
  but worth one sentence saying so.
- doc:92-93 — "the placeholder text becomes `(default)` after the value when it is the default": today's placeholders are `e.g. develop` and
  `{key}-{slug}` (`JiraReposGroup.tsx:266,283`) and the base default is derived (`defaultBaseProblem`, `:37`). Say which value `(default)` follows when
  the field is empty.
- doc:43 — "the rail is the only switch" is a paraphrase; the rule reads "the rail is the only thing that switches them" (`board.md:47`) and DESIGN §8.6
  "picked from the rail's sub-nav tree … and from nothing else" (`.claude/DESIGN.md:401`). Quote one.
