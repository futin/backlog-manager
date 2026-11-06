# App restyle — final whole-branch code review, 2026-11-05

Branch `feat/app-restyle`, worktree `backlog-manager-restyle`, range `eb3fd456..019d5b7f` (HEAD `019d5b7f`, tree clean). Brief:
`.superpowers/sdd/2026-11-05-shell-settings-restyle/final-review-brief.md`. Template: superpowers `requesting-code-review/code-reviewer.md`. Read-only; no
subagents; nothing in the tree, index or HEAD was changed. Layout was not re-checked — the four ui-verify reports (jira, runs-github, shell-settings, regression)
stand, and their kept deviations are read as accepted.

Evidence base: the whole diff read by area (server/ and shared/, then client/src/lib and hooks, then components, then docs); the four rule files the diff touches
(`security.md`, `board.md`, `tracker.md`, `jira.md`) and `invariants.md`; `pnpm run test:jest` on HEAD — 274 suites, 7269 tests passed, 1 skipped, exit 0,
173 s.

## Strengths

- **The two sweep routes are tight.** Both sit behind `SameOriginPostGuard` with `@HttpCode(200)`; neither reads anything a token could leak through — the
  GitHub route returns `this.trackers()` (the same payload `GET /api/trackers` serves) and the Jira route the `GET /api/jira` payload with `live` filled.
  `sweepNow` on both pollers decides everything before its first `await` (stopped / not-armed / 429 window / join the in-flight tick / `SWEEP_FLOOR_MS`), so two
  presses in one tick share one sweep and a press inside a window never calls out. The tracker's `sweepTargets` drops `off` repos and repos inside a sleep, so a
  `syncOff` repo is never swept even when named (`server/src/tracker/poller.service.ts:505`), and `isRepo` rejects a malformed `repo` with a 400 before the
  poller is touched (`server/src/tracker/tracker.controller.ts:56`).
- **No double timer chain.** The tracker's `schedule()` returns early while a timer exists and `tick()` leaves it alone; the Jira `sweep()` clears its timer on
  entry and reschedules only when `owed()`. A hand sweep therefore never leaves two chains running. The `forced` / `forceNow` marks are taken before any await.
- **One poll per tab, honoured.** `OrchestratorRunsProvider` is the one `useOrchestratorRuns()` mount; `useReportWorking` and every `onWorking` prop are gone and
  no view mounts the hook itself. `PullRequestsProvider` mounts its reader only while `hasTracker(trackers.projects)` — the PR read is armed only while
  something is connected, which is the tracker invariant restated at the shell. `run-pulse.test.ts`'s caller pin still passes.
- **Accessible names and confirm flows survive the restyle.** Merge still confirms through `PrFoot`'s `Confirm` (the split's main half calls `onMerge` only);
  Stop still confirms in place with the same `testId="jira-stop-confirm"`, `label="confirm stop"`, `Stop session` / `Keep running`; the rail counts are worded
  (`N PRs need you`, `N live runs`); the status buttons' names are stable (`GitHub: on time|late|down`, no age — #230). The Merge menu, Move-to and Session
  actions popovers focus their first enabled row on open and return focus to their trigger on pick.
- **Counts and guards stay consistent.** `useDialogEscape.ts`, `board.md` and `dialog-count-docs.test.ts` agree on eight dialogs and ten `Popover` composers
  (TrackerChip, Filters, Sort, JiraChip, JiraBoardPicker, JiraBoardSheet, JiraRunMenu, JiraDetail Move-to, SessionOpen, PrActions). Guard 7's one-home list
  gained `.ui-split`, `.ui-stripe`, `.ui-status`, `.ui-glyph-tile`; guard 9 pins `--main-gap` to exactly its two declarations. One `text-transform: uppercase`
  (`styles.css:167`); no `font-size` under 11 px; every inline style is a JSX `style={}` (CSSOM) — no `style=` attribute in markup and no `<style>` element,
  so the served CSP is untouched.
- **Error shapes are consistent with the client.** `lib/sweep.ts` reads `message` + `retryAt` for 409/429 and `error` for 400/404, which is exactly what the
  two controllers throw; `useSweep` splits 409 into `blocked` (buttons stay disabled) and everything else into a one-line `notice`.
- **Tests follow the routes.** `test/github-sweep-route.test.ts` (12 cases) and `test/jira-sweep-route.test.ts` (8) cover the guard, 409, 404, 429, the floor,
  joining an in-flight tick, the `off` skip, the PR TTL re-read and the no-token exit.

## Issues

### Critical

None.

### Important

None. Everything that reads as a spec gap is a logged decision (see Declined to judge) and everything that reads as a stale-state risk is bounded to one poll
interval or one popover open (Minor below).

### Minor

- **M1 `client/src/hooks/useSweep.ts:19` — `blocked` resets on every status poll, not when the poller's state changes.** `useEffect(() => setBlocked(null),
  [status])` keys on the `data` object that `useTrackers.ts:132` / `useJira.ts:87` replace with a fresh object every poll (15 s), so a 409's "GitHub is not being
  polled" sentence clears and the buttons re-enable after one interval even when nothing changed; a re-click re-409s. The doc comment claims "until the shell's
  status next changes". Fix: key the effect on the derived fact the 409 depends on (`status.armed` for Jira; token presence + `hasTracker` for GitHub), or keep
  the sentence until the next 200.
- **M2 `client/src/hooks/PullRequestsContext.tsx:39-43` — stale `read` survives a disable → enable flip.** `read` is never cleared when `enabled` goes false,
  so when the reader remounts the context briefly exposes the previous read (old `data`, a `refresh` bound to an unmounted hook) as `{ ...read, enabled: true }`
  until the new reader's effect fires. Bounded to one render and only on token/registry edits. Fix: `useEffect(() => { if (!enabled) setRead(null); },
  [enabled])`.
- **M3 `client/src/components/TrackerChip.tsx:165` — per-row sync posts `row.name` when `row.repo` is null.** `name = row.repo ?? row.name`; a project whose
  repo did not resolve has no row repo, so the click posts a project name, fails `isRepo`, and shows the 400 notice. Harmless but a dead button. Fix: disable
  the row's sync (as for `off`) when `row.repo === null`.
- **M4 `client/src/components/JiraChip.tsx:190` — `Last sweep` prints `every 15 s` whenever armed and not all-off, regardless of board intervals.** A site with
  one board at `60 s` reads `every 15 s`. Minor wording; fix by printing the fastest live board interval (`fastestInterval` in `lib/service-status.ts` already
  exists for this).
- **M5 `client/src/components/JiraChip.tsx:42,50` — `useJiraContext()` is called twice in one component.** Two destructures of the same context; fold into one.
- **M6 `client/src/lib/run-watchdog.ts:1`, `client/src/lib/pr-layouts.ts:3-4` — new type-only imports from `components/` while `run-stage.ts:122,323`
  states "`lib/` imports nothing from `components/`".** `prs.ts:2` already did this before the branch, so the convention was already soft, but the branch
  adds two more files on one side of the line and a restated rule on the other. Fix: either move `PillTone` / `DotTone` / `GlyphName` into a `lib/` or
  `shared/` type home and import them from the components, or soften the two comments in `run-stage.ts` to "no value imports".
- **M7 `client/src/components/jira/SessionOpen.tsx:77,175` — Stop's `Confirm` swaps the split out, so focus is lost after accept/dismiss.** Same shape
  `StopSession` had (the comment at line 26 says so), so not a regression; but the chevron that opened the menu is gone when `Confirm` unmounts. Fix: on
  dismiss, focus the split's `more` button; on accept, leave it (the row is busy).
- **M8 `docs/superpowers/specs/2026-11-05-app-restyle-design.md:234,240,293` — the binding spec still says `POST /api/jira/sweep` takes optional
  `{ boardId }` with a 404 `unknown board`; the route reads no body (`server/src/jira/jira-write.controller.ts:109`).** The deviation is decided (autopilot
  decisions 222/240/270: per-board stays #472's `boards/sweep`) and documented in `docs/subsystems/jira.md:348` and `DESIGN.md`, but the spec that the brief calls
  binding is not amended, so the next reader of the spec finds a route that does not exist. Fix: one line in §5 and the §8 failure list recording the
  deviation and pointing at `boards/sweep`.
- **M9 `docs/subsystems/jira.md:304` — cites `topSessionState` in `lib/jira-deck.ts`; the branch renamed it to `topSessionCell` (`jira-deck.ts:119`).**
- **M10 `docs/subsystems/jira.md:559` — says `StopSession` is mounted for the modal's Stop; the component is deleted and Stop now lives in `SessionOpen`'s
  menu + `Confirm`.** Rewrite the sentence to name `SessionOpen` and the `agentsOn && stoppable` gate `JiraSessionCard.tsx:143` applies.
- **M11 `docs/subsystems/invariants.md:4831` — `.rail-release` is now `.rail-foot`.** `board.md` and `DESIGN.md` were updated; this one history paragraph
  was not. Either rename or mark it as the old name.
- **M12 `server/src/tracker/tracker.controller.ts:56-61` and `server/src/jira/jira-write.controller.ts:111-112` — the 400/404 bodies use `error`, the 409/429
  bodies `message`.** The client handles both (`lib/sweep.ts`), and the server's other routes already split the same way, so this is consistency with the
  codebase rather than a bug — noted so nobody "fixes" one side only.

## Recommendations

- Fold M1–M3 into the same fix wave as the known `forceNow` stale entry (`poller.service.ts:817-819`) — all four are "state outlives the condition that set it"
  in the sweep path and share one test file each.
- M8–M11 are a single docs commit; M8 is the one that matters because the spec is the file the brief calls binding.
- M6 is a convention call for the user, not the implementer: pick one of "type-only imports are fine" or "move the tone unions", then make the two comments and
  the four files agree.

## Declined to judge

- **Site-wide Jira `Sync now` instead of the spec's per-board `{ boardId }`** — a logged autopilot decision (222, 240, 270) with the reasoning in
  `docs/subsystems/jira.md:348`; only the spec text is behind (M8).
- **Layout and pixel measurements** — the four ui-verify reports own these; their kept deviations (Popover radius 12, List columns, `Figure` label type, the
  stripe over the dot, the Watchdog policy row, the Activity ledger, Sources' control slot) are accepted as the brief says.
- **The parked plan-3 items** — Matrix Merge menu escaping `.prs` overflow, an armed PR on a `syncOff` repo, the pre-existing phone-width P1–P4.
- **Known items re-confirmed, not worse than described** — `forceNow` survives the no-token exit (`poller.service.ts:817` returns before the snapshot at
  `:819`); D13 / N1 column widths; the two Jira test flakes (the full jest run was green here); `site.notice` persisting until the next ask; the DashboardsPage
  null-view `scope=`; the stale `BACKLOG` kicker comments.
- **Whether `PillTone` / `GlyphName` belong in `lib/`** — raised as M6, but the decision is the user's.

## Assessment

**Ready to merge? With fixes** — none blocking. No Critical or Important finding: both POST routes hold the security invariants (same-origin guard, no token in
any response, `syncOff` refused, rate floor and 429 window honoured, no double timer), the one-poll-per-tab and connected-only-PR-read contracts are met, every
test-relied accessible name and confirm flow survives, the dialog and composer counts agree across code, docs and tests, and the full jest suite is green on
HEAD. The Minor list is three bounded stale-state edges in the sweep path (M1–M3), four wording/convention items (M4–M7) and four doc lines that lag the code
(M8–M11); all can land in the same fix wave as the already-known items.
