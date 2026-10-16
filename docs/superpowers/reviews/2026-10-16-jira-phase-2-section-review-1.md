# Review 1 — `docs/superpowers/plans/2026-10-16-jira-phase-2-section.md`

**Reviewer:** fresh subagent (Fable), plan checklist 1–7 · **Spec:** `docs/superpowers/specs/2026-10-15-jira-integration-design.md` · **Date:** 2026-10-16

## Verdict: APPROVE WITH FIXES

No Critical findings. Three Important ones, each a stated fact about the code or a test value that the code contradicts; none changes the plan's shape.
Every file path, exported name and test file the plan names was checked against the tree (section "Reality" below); all hold except where noted.

## Important

### I1 — plan:322, 325, 510 — the age strings are spelled `12s ago` / `0s ago`; the one existing formatter prints `12 s ago`

`client/src/lib/tracker.ts:41` (`pollAge`) returns `` `${Math.floor(ms / 1000)} s` `` under a minute, and `trackerState` (`tracker.ts:230`) prints
`polled ${age} ago` — so the Trackers row and the item modal already read `polled 12 s ago`, with the space. The plan's expected values for `bandSub`
(`polled 12s ago`, line 322), `boardRowLine` (line 325) and the sheet's check line (`checked 0s ago`, line 510) drop it. The spec is split with itself —
§6.2 writes `polled Xs ago`, §6.4 writes `checked 3 s ago` — so the code's existing format is the tie-breaker, and an implementer who reuses `pollAge`
(the right move: "every derivation has one home") fails these cases, while one who satisfies them verbatim writes a second age formatter.

→ Fix: add a ruling (R9) that every Jira age goes through `pollAge`, and change the three literals to `polled 12 s ago`, `last polled 12 s ago`,
`checked 0 s ago`. R8's `not polled yet` is unaffected.

### I2 — plan:196, 213–214 — `test/jira-poller.test.ts` has no fake timers, and the 20 s race case cannot be built on the fetch-level fake

Line 196 says the suite is extended "on its existing fake client and fake timers". `grep -n useFakeTimers test/jira-poller.test.ts` finds nothing; the
suite's own header (`test/jira-poller.test.ts:26`) says every sweep is driven by `await poller.tick()` and the chain's timer is observed only through
`armed`. So the implementer must introduce fake timers for Task 2 — which also means re-checking the suite's existing `await`-driven cases under them.

Worse, the case at 213–214 ("the fake client's search never settles … `boardSaved` resolves at 20 s of fake time, and the sweep's eventual answer still
lands") is not reachable with `FakeJira` as it stands: the fake sits at `fetch` INSIDE a real `JiraClient` (`test/helpers/jira.ts:12`,
`test/jira-poller.test.ts:63`), and the client aborts every call at `JIRA_TIMEOUT_MS = 10_000` (`server/src/jira/jira.client.ts:30`, :165). A fetch that
never settles is aborted at 10 s, the sweep ends in failure, and `boardSaved` resolves at ~10 s — before the 20 s cap, with no "eventual answer" to land.
`FakeJira` also has no delay hook (`FailNext` at `test/helpers/jira.ts:56` answers at once or throws).

→ Fix: state that Task 2 adds `jest.useFakeTimers()` to the suite (or a nested `describe` with them), and rewrite the cap case so the sweep genuinely
outlasts 20 s within the client's per-call deadline — e.g. a board with three roots whose fake answers are each delayed 8 s (a `delay` hook added to
`FakeJira`, the way `failNext` is), or a `jest.spyOn(client, 'search')` returning a deferred the test settles after the 20 s advance. Name which.

### I3 — plan:400 — `test/nav.test.tsx:388` pins `SECTIONS` to the four names and will fail when Task 7 widens it

`expect(SECTIONS).toEqual(['board', 'runs', 'archive', 'settings'])`. Task 7's Step 4 says to run "every suite that renders `SideRail`" and expect PASS;
`nav.test.tsx` does render `SideRail`, so the grep finds it, but the step reads as "run and observe green", not "edit this assertion". An implementer
following the plan literally gets a red suite with no instruction.

→ Fix: list `test/nav.test.tsx` under Task 7's Files (modify: the `resolveSection` pin becomes the five names, `jira` between `archive` and `settings`).

## Minor

- plan:144 — Task 1's text edits `status()` in `server/src/jira/poller.service.ts` (`armed: this.armed`, `home: homedir()`), but that file is not in Task 1's
  Files list. Add it as Modify so the commit's scope matches.
- plan:30, 587 — every component from Task 7 on cites DESIGN.md §8.9.x, which Task 13 writes last, so six commits carry citations to a section that does not
  exist. No suite checks citations resolve (`test/design-guards.test.ts` pins §8.2's values only), so nothing goes red — but a reader of an intermediate
  commit finds a dangling reference. Consider writing §8.9's four headings (even as one-line stubs) in Task 7 and filling them in Task 13.
- plan:151, 162 — `parseBoardWrite`'s `id` is typed `string | null`, and a well-formed-or-malformed STRING id is routed to `writeBoard`'s 404. A non-string
  `id` (`7`, `{}`) is unspecified: 400 naming `id`, or coerced to "create", or 404? Pick one and add the case.
- plan:299 — "formatted by `lib/item-age.ts`'s existing formatter": that module exports `daysSince`, `elapsedSince`, `formatCreated`, `formatSeconds`
  (`client/src/lib/item-age.ts:24–160`). Name `formatCreated` (the card-age one) so the implementer does not pick `elapsedSince`.
- plan:566, 574 — the chip reads `initialsOf(me.name)` (`AL`); spec §6.5 says "initial" (singular) and `TrackerChip` draws one letter
  (`.claude/DESIGN.md:186`). Either is fine; record it as a ruling so the §6.5 deviation is deliberate.
- plan:495, 533, 545 — both the board sheet's `Unresolved in a project…` `Select` and the Repositories add row read `/api/jira/projects`, and Task 11 asserts it
  is fetched "once per Setup mount". Say who owns the list (the Setup view, handed down to the sheet and the group) so the sheet does not add a second fetch.
- plan:85 — `BOARD_TRACKER_POLL_MS` lives in `client/src/hooks/useBoard.ts:21`, not `lib/tracker.ts`; worth a path since Task 6 imports it.
- plan:413 — `FilterBar`/`FilterSection` live in `client/src/components/FilterBar.tsx:62, :203`, not under `ui/`. Not wrong (the plan gives no path), but Task
  8's header comment will want the right one.

## Checklist

1. **Coverage** — spec §12 phase 2: rail entry and tree (T7), `JiraProvider` (T6), Board page (T8), read-only modal + `Fact`/`marked` hoists (T4, T9), Setup
   with the sheet, Repositories, Connection (T10, T11), boards/repos routes and writers (T1–T3), chip and Trackers row (T12), the §13 section-and-tree rule,
   DESIGN §8.9, §8.7's two sentences, `board.md`'s Escape bullet, `invariants.md`'s Escape section and `dialog-count-docs` three → five (T13),
   `SettingsRow` promotion and `BoardColumnSlug` widening (T4). §11's phase-2 suites all have a task. Spec §2's per-browser keys (T5/T8), §6.1's hold-and-fall
   (T7), §6.2's stacking below 700 px (T8), §6.5's chip home below 700 px (T12). Nothing phase-2 is unowned; phase 3/5 items are listed as absent at
   plan:136–137 and match §12.
2. **Values** — every copy string checked against §2, §5, §6.2–6.5, §8: band sub, `first 500 shown`, `No boards yet`, `jira.json cannot be read`, the Boards
   row line, `sync off · last polled`, the preset chip labels, `Create board`, the Repositories warning and hint, Connection's `every 15 s`/`idle`/`no 429
   since start`, the Trackers row, `Comments stay in Jira — v1 neither reads nor writes them`, `could not read the ticket — <message>`, the no-repo hint, the
   §13 headline (byte-equal at plan:597–598). The one mismatch is the age spacing (I1).
3. **Reality** — exists (Modify): `shared/types.ts` (`JiraStatusPayload` at :642, `JiraBoardStatus`, `JiraBoardFailure.message`, `isSyncInterval` :529,
   `SYNC_INTERVALS` :516, `DEFAULT_JIRA_INTERVAL` :663), `server/src/jira/config.util.ts` (`isJiraId` :44, `JIRA_PROJECT_KEY_RE` :49, `JIRA_JQL_MAX_CHARS`
   :57, `readJiraConfig` :171; no writer, no `JiraConfigUnreadableError` yet), `poller.service.ts` (`get armed` :181, `arm` :195, `tick` :213 returning the
   in-flight promise, `status` :223, `boardIssues` :274, `owed` :422, `coldOwed` :428, `due` :433, `run` :493 with the boot gate at :500), `jira.module.ts`
   (`controllers: [JiraController]` :27; the "write routes phase 2 adds" sentence :17), `agents/origin.guard.ts:66` `SameOriginPostGuard`,
   `tracker-sync.controller.ts:10` as the import precedent, `tracker/sync-config.util.ts:96` `writeSyncInterval`, `test/jira-routes.test.ts:307` the
   `POST /api/jira/boards is 404` case and :311 the prompt case, `test/helpers/jira.ts` `FakeJira`, `ItemModal.tsx:190` `Fact`, :162 `marked.use`, :66/:78/:104
   `classifyTarget`/`isAllowedTarget`/`escapeHtml`, `components/settings/SettingsRow.tsx` with importers `SettingsView`, `TrackersGroup`, `WatchdogGroup`
   (the `ui/NumberField.tsx`, `ui/Segmented.tsx`, `test/ui-segmented.test.tsx`, `test/ui-band.test.tsx` hits are comments, not imports), `test/settings-view
   .test.tsx:661` the `'./SettingsRow'` regex, `BoardColumn.tsx:23` `BoardColumnSlug` and :36 `RAMP_SLUGS`, `lib/sections.ts:30` `SECTIONS`, `App.tsx:46`
   `resolveSection` (any `SECTIONS` member passes), :108 `change`, :121 one chip and :132 `chipSlot`, :173 `onOpenWatchdog`, `SideRail.tsx:21` `RAIL_LABEL`,
   :201 `RailTree`, :340 `ICON_PATHS`, `lib/settings.ts:277` `LANDINGS = ['last', ...SECTIONS]` (so `clampSettings` accepts `jira` by itself) and
   `SettingsView.tsx:59` its hand-written copy list (so "offered only while configured" is a real edit), `hooks/useTrackers.ts:37` `TRACKER_FETCH_SLACK_MS`,
   `TrackersContext.tsx:15` the LOADING default, `useCoalescedFetch.ts:23` `{ armed, intervalMs }`, `useRunsMode.ts:66/:71`, `usePersistedState.ts:10`,
   `lib/tracker.ts:86` `pollProgress`, :369 `isTrackersPayload`, `useDialogEscape.ts:18` "Three of them now, not four" and :31 the three `Popover` composers,
   `test/dialog-count-docs.test.ts:37–69` the three-count assertions, `test/ui-modal.test.tsx:97` the one-composer assertion, `.claude/DESIGN.md:390` §8.7
   with both sentences (:394, :398), §8.8 Motion the last subsection (so §8.9 is free), `.claude/rules/board.md:11` the Escape bullet, `.claude/rules/jira.md:13`
   "Phase 1 has NO write path", `docs/subsystems/invariants.md:1689` and :2954 the two headings, `docs/subsystems/jira.md`, `board.md:55` the `ui/` table,
   `CLAUDE.md:48` "four lazy sections", `docker-compose.yml:54` `HOME: ${HOME}` (R1's premise holds), `test/helpers/dates.ts`, `test/helpers/app.ts`, every
   test file the plan lists as existing. Does not exist (Create): `server/src/jira/jira-write.controller.ts`, `client/src/components/jira/`, `ui/Fact.tsx`,
   `ui/SettingsRow.tsx`, `lib/markdown.ts`, `lib/jira.ts`, `lib/jira-page.ts`, the three new hooks, `JiraChip.tsx`, and all nine new test files. The read
   controller's rules the plan leans on hold: malformed board id → 404 `unknown board` (`jira.controller.ts:45`), `Jira is not configured` 503 (:108).
4. **Interfaces** — every Consumes is Produced earlier with the same spelling: `writeBoard`/`deleteBoard`/`writeRepos`/`parseBoardWrite`/`parseReposWrite`/
   `JiraConfigUnreadableError`/`JiraUnknownIdError` (T1 → T2/T3); `boardSaved`/`boardDeleted`/`JIRA_SAVE_SWEEP_WAIT_MS` (T2 → T3); `Fact`/`renderMarkdown`/
   `SettingsGroup`/`SettingsRow` (T4 → T9–T11); the `lib/jira.ts` set and `useJiraPage`/`setJiraPage` (T5 → T6–T12); `useJiraContext`/`useJiraBoard`
   (T6 → T7–T12); `onOpenJiraPage` (T7 → T8, T10). `JiraState` deliberately omits `TrackersState`'s `saveInterval`/`refusals` — fine, nothing consumes them.
5. **Order** — no forward dependency. T7's placeholder pages are replaced by T8/T10 before the plan ends (plan:378–379). Phase 1 is on `main` (the branch's
   base) — the server symbols T1–T3 extend all exist.
6. **Tests** — every task's Step 1 fails before Step 3 (missing exports, missing routes, missing components); cases pin behaviour (strings, requests made,
   file bytes) rather than internals. Review Focus 1 → plan:249 (T3) and :211–212 (T2); 2 → :252, :439, :513; 3 → :429; 4 → :178–181; 5 → :392. The two
   test-design problems are I2 and I3.
7. **Conventions** — behaviour and exact cases throughout, no literal code; budgets soft; 160-column wrap; every task commits with a message; interfaces are
   the one place names are fixed. One slip: Task 1 edits a file it does not list (Minor 1).

## Rulings reviewed (plan:36–60)

R1–R8 are sound and each is recorded where a reviewer can reject it by number. R2's 20 s wait is the right trade (the client otherwise never refetches an
`off` board's list); R4's `.`/`..`/`//` refusal is stricter than §5 and the plan says so at :628. R6's count checks out against `useDialogEscape.ts:31`.
