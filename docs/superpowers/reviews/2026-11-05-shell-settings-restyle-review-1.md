# Review 1 — Shell and Settings restyle plan (4 of 4)

Plan: `docs/superpowers/plans/2026-11-05-shell-settings-restyle.md` (commit 9f4aceff). Spec: `docs/superpowers/specs/2026-11-05-app-restyle-design.md`.
Reviewed against `main` after the rebase that brought in #472 (b3c73fa5, `feat(jira): per-board sweep now button in the Jira chip popover`), which the
plan was written before. Plans 1–3 (`jira-restyle`, `jira-rest-restyle`, `runs-github-restyle`) were read only for the interfaces this plan consumes.

## Verdict: REVISE

One Critical: Task 4 and Task 7 build a second Jira sweep path over one that #472 already merged, with different `off`-board and 429-window semantics and
a client test that pins the existing URL. Everything else is Important or Minor; the plan is otherwise well-anchored (every cited line range was checked
and all but one resolve to what the plan says).

## Critical

**[C] plan:139-161 (Task 4) and :226-233 (Task 7) — `POST /api/jira/sweep` with `{ boardId }` and the per-row `Sync <board>` icon duplicate the merged
`POST /api/jira/boards/sweep`.** `server/src/jira/jira-write.controller.ts:101-123` already serves `POST /api/jira/boards/sweep` `{ id }`, which awaits
`poller.boardSaved(id)` and answers `{ ok: true }`; `client/src/components/JiraChip.tsx:67-89` already posts it from a per-board `now` button and holds the
`sweeping` / `refused` state the plan's Task 7 re-describes; `test/jira-chip.test.tsx:214` asserts the URL `/api/jira/boards/sweep`, `:253` asserts an `off`
board keeps its `now`; `test/jira-write-routes.test.ts:86-137,200-216` cover the guard, the 400 and the 404 for it; `docs/subsystems/jira.md:139,350`
document it. The merged route's documented semantics differ from the plan's `sweepNow(boardId)` on two points: an `off` board IS swept ("a manual-only
board is the one a `now` exists for", controller :108-109) where the plan says skipped → `done` (plan :149-150) and the row icon is "disabled for `off`,
title `sync is off`" (plan :230-231); and inside a 429 window the merged route does not refuse — the board stays owed (controller :104-105) — where the
plan answers 429 (plan :148-149, Review Focus 1). Built as written the server has two routes for one action, `jira-chip.test.tsx:214,253` go red, and the
`off`-board behaviour a merged PR decided is silently reversed.
→ Rewrite Task 4 so `POST /api/jira/sweep` is the SITE-WIDE sweep only (no `boardId`; 400 for any body that is not an empty object) and the per-row
icon in Task 7 keeps posting `/api/jira/boards/sweep` `{ id }` through the existing `sweep` callback (`JiraChip.tsx:67`), keeping the existing `now`
semantics for `off` boards (spec §5's "a repo whose sync is `off` is skipped" is about GitHub repos; the Jira per-board button's `off` behaviour is #472's
decision and the plan must either keep it or state the override). Say explicitly that only the site-wide button answers 429 inside a window. Add
`test/jira-chip.test.tsx` to Task 7's Modify list with the cases that move (the `now` label → `Sync <board>` if renamed; `:253` kept). Cite
`jira-write.controller.ts:101-123` as the neighbour the new route sits beside, not `:65+`.

## Important

**[I] plan:93-97 (Task 2) — `working: undefined until the first answer` has no source: `useOrchestratorRuns()` exposes no "answered" flag and no error.**
`client/src/hooks/useOrchestratorRuns.ts:109-117` returns `runs` (starts `[]`), `starting`, `remote`, `remoteStarting`, `refresh`, `noteResume`,
`resuming`; its own comment says "There is no error field on this hook's return value" (:186 in the body) and that `[]` before the first fetch and `[]`
after it "render identically". The provider cannot tell "not answered" from "answered, nothing running", so Review Focus 4 (plan :48) cannot be built
from the Modify list, which omits the hook. → Add `client/src/hooks/useOrchestratorRuns.ts` to Task 2's Modify list with a produced `answered: boolean`
(or `loaded`) set on the first resolved payload, and a `test/orchestrator-hook.test.tsx` case for it (false before, true after the first answer, still
true after a later failure).

**[I] plan:47 (Review Focus 3) vs plan:122-124 (Task 3) — the PR reader's gate contradicts itself.** Review Focus 3 says with "every GitHub repo `off`, or
no token … the PR reader never mounts"; Task 3 gates the reader on `hasTracker(data.projects)` — true whenever a GitHub project is REGISTERED
(`client/src/lib/tracker.ts:450-452`: `source === 'github'`), token or not, `off` or not — and justifies it so "the PRs page's own no-token message keeps
working". Task 3's only gate test is "no GitHub project → no request". An implementer cannot satisfy both. The spec (§4.9a :201) says "mounted … when
GitHub is connected (never while nothing is connected)". → Pick one and say it in both places. If the Task 3 gate stands (reasonable: `GET /api/prs`
answers `{ token: false, repos: [] }` without reading the registry, `pulls.service.ts:171-178`, so the no-token read costs nothing outbound), rewrite
Review Focus 3 to "the GitHub pill is red/grey, the Needs-you count is 0 and hidden, and Sync now answers 409" and drop "the PR reader never mounts"; add
a Task 3 case for the no-token payload (reader mounted, pill hidden). If the spec's "connected" is meant, gate on `hasSyncingTracker` plus
`platforms[].hasToken` and say how the PRs page shows its no-token message without the context's data.

**[I] plan:207-209 (Task 6) — `aria-current="page"` on the current sub-page row contradicts the rail's documented and pinned `"true"`, and the plan says
`nav` keeps its cases.** `client/src/components/SideRail.tsx:319-326` explains the tree entries carry `aria-current="true"` because the section row holds
`page` and "two elements claiming to be the current page would leave a reader with two answers"; `test/rail.test.tsx:160-161,253-259,268` assert `'true'`.
Spec §8 (:289) asks for `page`, so the plan follows the spec, but it does not say the section row gives up `page`, and it lists neither `rail.test.tsx`'s
existing `'true'` assertions as moving nor the SideRail comment as rewritten. → State the markup: either the section row keeps `page` and the sub row
keeps `true` (then the test case in :208 is wrong and spec §8 needs the deviation reported), or `page` moves to the sub row while a section is open and
the section row drops it; list `rail.test.tsx:160,253-259,268` as the assertions that flip and the comment at `SideRail.tsx:319-326` as rewritten.

**[I] plan:308-309 (Task 10) — most of Task 10's "failing tests" pass today, so they do not pin the two-pane page.** `DashboardsPage.tsx:221-224`
already disables ↑ at index 0 and ↓ at the last index and `:175` already posts `saveSuggestion({ order })`; no `sessions in use` text exists today
(`test/settings-dashboards.test.tsx:234,271` already assert `connected · spawn on`); `usageTone` already answers amber at 76 and red at 91
(`lib/dashboards.ts:233-236`). Only the `.ui-pill-off` title case can fail first. → Add cases that fail before the rebuild: the list row carries a
status dot, the two meters with `data-tone` from `usageTone` and the `this machine` tag; the detail carries two usage tiles with reset text, the Models /
Efforts pill rows, and the four facts; the page stacks below 1100 px (a stylesheet case, as `settings-view.test.tsx:1054` does today).

**[I] plan:151-152 (Task 4) — the Jira 200 payload is described as "GET `/api/jira/status`", a route that does not exist.** The controller is
`@Controller('api/jira')` with `@Get()` (`server/src/jira/jira.controller.ts:45,63`), i.e. `GET /api/jira`. The line cite (:63-66) is right; the path is
not, and an implementer grepping for `status` finds nothing. → Write `GET /api/jira`.

**[I] plan:142 (Task 4) — the Jira controller citation `jira-write.controller.ts:65+` predates #472 and the Modify list omits the files the new route
touches.** The class now holds nine POST routes (header :30), and `test/jira-write-routes.test.ts:86-137` is an `it.each` over every guarded path that
the new route must join (the plan runs that suite but does not list it as Modify). → Cite `:101-123` as the neighbour, list `test/jira-write-routes.test.ts`
and `docs/subsystems/jira.md` (route table :139) under Modify.

## Minor

- plan:88 — `ArchiveView.tsx`, `BoardView.tsx`, `PullRequestsView.tsx`, `RunsView.tsx`, `GithubAccessGroup.tsx` are cited without their directories; they
  live under `client/src/components/{archive,board,github,runs,github}/`. Unique names, so harmless, but `test/run-pulse.test.ts:68-73` spells the full
  paths and the new guard shape should too.
- plan:234 — "the login- and `.tracker-meters`-hiding cases are deleted" names two of the four cases in `test/rail-bar-style.test.ts:24-58` that would be
  vacuous or red without `.tracker-name` / `.tracker-meters`; "hides the login nowhere else" (:28) and "keeps the two-chip rule out of the desktop strip"
  (:56) go with them. Say "the four `.tracker-name` / `.tracker-meters` cases".
- plan:203 — "inside a `button.rail-count` (the old `rail-badge` behaviour and name)" reads as two class names for one element; `rail.test.tsx:519`
  queries `.rail-badge`. Pick one class and say the test selector follows it.
- plan:201-202 — "the open section's row is white (`--strip`) with an ink tile; … the current one a white row" paints two white rows at once; spec §4.9
  (:182-183) paints only the current page white. Say which the mock shows, or report the deviation.
- plan:174 — "re-reads those repos once past `PR_TTL_MS`" is ambiguous (only if past, or forcing past); the Step 1 case at :183 ("re-read once per swept
  repo inside its TTL") settles it as forcing. Say "regardless of `PR_TTL_MS`, through `reading`'s one-in-flight join" in the interface line too. Note
  `refresh` is private (`pulls.service.ts:428`), so `refreshNow` must bypass its TTL check rather than call it.
- plan:104-105 — the 3-calls-in-10-s provider case depends on `useRefreshing` re-arming `intervalMs` AFTER each answer settles (`.claude/rules/board.md:151-153`);
  with fake timers the test has to flush the resolved fetch between advances or it counts 2. Worth one sentence so the implementer does not loosen it to `>= 2`.
- plan:285 — `HALT_OPTIONS` / `PLANS_OPTIONS` / `PRS_OPTIONS` (`TickGroup.tsx:44-46`) are `{ value: string; label }` Select options built by `ladder(...)`,
  not numeric ladders; the steppers need the numbers (`ladder`'s input limits). Say "the numeric ladders those options are built from".
- plan:284 — `ladderWithSelected` is module-private (`WatchdogGroup.tsx:121`, no `export`); fine inside the file, but the wording "via `ladderWithSelected`"
  should not suggest importing it.
- plan:323 — "any suite `grep -l 'DESIGN.md\|board.md' test/` lists" is 42 suites, nearly all of which only cite DESIGN.md in a comment. The two that read
  the docs are `design-guards` and `dialog-count-docs`, already named. Drop the grep or scope it to `readFileSync.*DESIGN`.
- plan:228-231 — Task 7 rewrites both chip popovers but does not list the two header comments that state the rule the spec overrides
  (`TrackerChip.tsx:27-28` "No links and no buttons in the popover", `JiraChip.tsx:33-35` "No links in the popover"). Add them to the override edits.
- plan:160 and :186 — two empty `- [ ]` checkbox lines.
- Pill tones: `Pill` has `neutral | live | warn | bad | done` (`ui/Pill.tsx:3`); the plan's `neutral` = grey, `warn` = amber reading is right.

## Checklist record

1. **Coverage.** §4.9 rail → T6; counts §4.9a → T2/T3/T6; status pills + popover head + Sync now → T7; §4.10 all pages → T8; Local → T8; Shared → T9;
   Dashboards → T10; §5 routes → T4/T5; Read again → T9; §8 Rail/Status pill/Sweep routes/Settings/Dashboards/Guards cases → T6/T7/T4+T5/T8/T10/T1-T10;
   §9 DESIGN overrides → T11; ui-verify → T12. No spec section in scope lacks a task. Spec §4.9a's "readers pause with the page's visibility handling, if
   the poll they reuse has it" — neither hook has one (`useOrchestratorRuns.ts`, `usePullRequests.ts`), so nothing is owed.
2. **Values.** Copy strings checked against the spec: `Jira asked to wait until <time>`, `GitHub asked to wait until <time>`, `unknown board`,
   `<repo> is not the repo of a registered GitHub project` (`pulls.service.ts:325`), `saves in this browser only` / `saved on this machine`, `this browser` /
   `this machine`, `Open` / `GitHub page` / `Jira setup`, `Last read <age> · Read again`, `API connected` / `API unreachable`, merge-mode card titles —
   all match. `usageTone` 75/90 matches `lib/dashboards.ts:233-236` (spec §7 defers to the existing threshold). `Graphite` theme exists
   (`lib/settings.ts:22`). One wrong path: `GET /api/jira/status` (Important above).
3. **Reality.** Every Create path is absent; every Modify path exists. Cited ranges resolve: `App.tsx:76-97,184-229,371-378,416-426`; `run-pulse.ts:24`;
   `useOrchestratorRuns.ts:109`; `remote-run.ts:24`; `run-pulse.test.ts:64-94`; `pulls.service.ts:23-30,325,428`; `tracker.md:109`; `board.md:47-55,65-67,151`;
   `prs.ts:242`; `poller.service.ts` (jira) `:272`; `jira.controller.ts:63-66`; `poller.service.ts` (tracker) `:451,749-786,1115`; `tracker.controller.ts:32-40`;
   `SideRail.tsx:99,162-171,209-224,297-305,335,422`; `styles.css:147,1288`; `SettingsRow.tsx:76`; `SettingsView.tsx:123-177,209-235,239`;
   `settings-view.test.tsx:82-92,387,1054`; `SourcesGroup.tsx:35-97`; `TimeZoneGroup.tsx:25-55`; `WatchdogGroup.tsx:49-73,103-105,136,205-290`;
   `TickGroup.tsx:44-70`; `DashboardsPage.tsx:105,221-239`; `dashboards.ts:233`; `DESIGN.md:166,192,393,401,518`; `design-guards.test.ts:323,380-396`;
   `daylight-contrast.test.ts:393`. Stale: `jira-write.controller.ts:65+` (the route now at :101-123 is what matters).
4. **Interfaces.** `StateTone` (plan 2 T1, `lib/tones.ts`), `GlyphTile` tones incl. `ink` (plan 2 T1), `Glyph`/`GlyphName` (plan 1 T1, `ui/Glyphs.tsx`),
   `Segmented count` (plan 2 T2), `Pill` tones, `useOrchestratorRuns`, `runsWorking`, `isRemoteRun`, `splitReach`/`rankPrs`/`levelCounts`/`groupRepos`,
   `hasTracker` (accepts `TrackerProjectRow[]`, `tracker.ts:450`), `useTrackersContext` (`error` is boolean), `pollAge`, `SYNC_INTERVALS`, `saveSuggestion({order})`,
   `usageTone` — all exist with the spelling used. Plan 1 (`ui/Glyphs.tsx`) is spelled `Glyph`/`GlyphName` here, consistent.
5. **Order.** T1 → T6/T7/T9 (StatusPill, stepper); T2 → T6; T3 → T6; T4/T5 → T7/T9 (`postSweep`); T8 → T9/T10 (`SettingsGroup pill`). No forward dependency.
   Popover composer count stays ten (plans 1–3 move it; this plan adds no composer) — consistent with plan 3 T2 (:117-120).
6. **Tests.** T1, T2, T3, T4, T5, T7, T8, T9 cases fail first and pin behaviour. T10 mostly does not (Important). Review Focus 1 → T4 case "inside a stored
   429 window" + T7 "429 text"; RF2 → T4/T5 concurrent and 1 s-later cases; RF3 → T5 409 + T7 red/grey (but see the gate contradiction); RF4 → no test
   named for "request fails or has not answered → `working` undefined, Runs pill hidden" (add with the `answered` flag); RF5 → T1 off-ladder 90000 case +
   T9 "off-ladder stored value renders and steps" ✓. Fixtures discriminate where stated (5m/4min vs 15s/31s rows; both pools set, secondary later).
7. **Conventions.** Behaviour and cases, no literal code ✓; soft line counts ✓; 160 columns ✓; commit titles pass `ci / pr-title` ✓.

**Hard rules.** Every route under `/api` ✓ (`api/jira`, `api` controllers). Token never leaves the server ✓ (200 bodies are the payloads already served).
Server never writes git ✓ (both sweeps are reads). Outbound modules only `tracker/`, `jira/` ✓. Poller never armed by a sweep ✓ (`not-armed` → 409, no
`arm()`). Guard 7 ✓ (plan :29-32 states it; T6 :205 repeats it). `daylight-contrast` PINNED ✓ (T1 :78 conditional, T6/T7/T8/T10 run it). `run-pulse`
guard: moved with the spec §4.9a reason in the same commit ✓ (T2 :101-105). `dialog-count-docs` untouched ✓. CSP: theme preview cards via `data-theme`,
no inline style ✓ (:255-256). `tracker.md` / `board.md` / `pulls.service.ts` header move in one commit with the reason ✓ (T3 :133-134). Rule files whose
paths the plan touches: `board.md` (client, `security.ts` untouched), `tracker.md` (tracker/), `jira.md` (jira/) — the plan edits `board.md:47-55,65-67`
and `tracker.md:109` and names the override; `jira.md`'s rule file (`.claude/rules/jira.md`) is not listed by any task although T4 adds a Jira route —
check whether its route table or guard sentence needs the new route (Minor; the subsystem doc `docs/subsystems/jira.md:139` definitely does).
