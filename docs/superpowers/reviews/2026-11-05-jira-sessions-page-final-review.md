# Final whole-branch review — `docs/jira-sessions-page` (5c8b7e80..d525c44c, 10 commits)

Verdict: **Ready with fixes** — no correctness defect found across the task seams; every Review Focus item is handled and pinned. The fixes are comment and doc truth
that the spec's Constraints make a requirement ("Docs and comments that describe the old shape must follow").

Method: superpowers `requesting-code-review/code-reviewer.md`, one pass by me over the full diff, the spec, the plan, the mocks' source and the ui-verify record (browser
check not redone). Read-only; nothing but this file written.

## Verification run

- `pnpm exec jest` on 24 suites — the touched ones and every guard that reads the client tree or the symbols the branch adds callers of: `rail`, `jira-list`,
  `jira-board`, `jira-view-store`, `filter-bar`, `use-jira` (`useJiraContext`, `useJiraBoard`), `jira-lib`, `jira-setup` (`JIRA_BOARD_KEY`), `jira-detail`, `jira-launch`,
  `jira-sections`, `design-guards`, `csp`, `dialog-count-docs` (Popover composers), `ui-kit-guard`, `ui-kit-tokens`, `time-zone-guard`, `chevrons`, `daylight-contrast`,
  `section-boundary`, `use-now` (`useNow`), `ui-popover`, `ui-pill`, `ui-dot` → **24 suites, 701 tests, all pass**.
- `grep -l` in `test/` for `useJiraSessionsContext`, `usePickedJiraBoard`, `rowOpens`, `JiraSessionList`, `JiraSessionsView`, `JiraIssueList`, `JiraBandSub`,
  `JiraBoardPicker`, `listDotTone`: no guard suite names them (no symbol-count guard to update). `useNow` / `useJiraContext` hits are behaviour suites, all green.
- `pnpm run typecheck` → clean.

## Seams checked (focus 1)

- **One stored pick, nudge refresh.** `usePickedJiraBoard` is the only reader of `JIRA_BOARD_KEY` on both pages; only one page is mounted at a time, so the
  per-caller `usePersistedState` cannot diverge. `nudge` reaches `useJiraBoard` on both. Pinned: jira-list "picking a board on the Sessions page is the Board page's
  pick", "a row click opens Detail … a landed write re-reads the board list". `loading` in `useJiraBoard` is first-load only (L103), so a nudge/poll never flips the
  Sessions body to `loading…`.
- **Rail badge.** `SideRail` sets page `sessions` + filters, drops `setJiraView`. Pinned from Setup with view `board`, and with view `list` stored (stays `list`).
  Sessions entry carries no count (rail test).
- **Issue List = Board's tops.** `rows = sortTops(fold.tops ∩ kept)`; folded issues never rows. Pinned (keys, discriminating order case, folded keys absent). The
  ui-verify sub-task rows are Board tops too (parent not collected) — matches spec D2.
- **Row click / Detail.** `onOpenIssue(top, fold.childrenOf)`; `rowOpens` excludes the key link and summary button. Pinned with the childrenOf index asserted.
- **`unavailable` + All tickets.** Precedence unreadable → no board → loading → failed, identical to `JiraBoardView`. Bar always drawn; body swaps only with All
  tickets off; foot hidden in that state. Pinned for no-boards and failing, both toggles.
- **Stale stored values.** `jira-page` junk falls through `isJiraPage`; `jira-view` `list` lands on the issue table (spec C5, accepted). No `Record<JiraPage,…>` misses
  `sessions` (typecheck).
- **Anti-goals.** No second sessions poller (`JiraSessionsView` reads `useJiraSessionsContext` via `JiraSessionList` only); no sub-task rows; one picker store.

## Review Focus (focus 2)

| # | Item | Code | Test |
| - | ---- | ---- | ---- |
| 1 | Board unusable + All tickets off: bar still drawn | `JiraSessionList` `unavailable` branch | jira-list: no-boards case; failing case |
| 2 | Badge from Setup / Board-List; view untouched | `SideRail.tsx:214` | rail: "lands on the Sessions page…", "no longer writes the Board page's view" |
| 3 | Live only on folded child marks top, child never a row | `topSessionState(boardAgents(...))` | jira-board "marks a top for a session live only on a folded child" |
| 4 | Two sessions on one card → deck's lead | `topSessionState` first-entry | jira-lib (plan>working; starting>lost by newest start); jira-board deck cross-check |
| 5 | Detail write from Sessions re-reads list | `usePickedJiraBoard(nudge)` | jira-list fetch-count case |

All five handled and pinned.

## Spec coverage (focus 3)

Every D1–D6 and C1–C9 item is implemented. Deviations, all minor and listed below: Key cell is a link (mock draws plain bold text); unassigned reads `unassigned`
(logged ruling in ui-verify). No spec requirement found unimplemented.

## Findings

### Critical

None.

### Important

- **I1** `client/src/hooks/useJiraView.ts:7` — the header still says the rail badge's click "(C4 sets page `board` and view `list`)"; this branch removed exactly that
  write. Same class of stale old-shape comment at `client/src/styles.css:195` (`.rail-badge` "it opens the List"), `client/src/styles.css:1426` ("The List view" for
  the session table) and `:1465` ("JiraSessionList's `rowOpens`" — it now lives in `lib/jira-list.ts`), `client/src/lib/jira-deck.ts:14` ("the List view is where it
  lives" — off-board sessions live on the Sessions page now), `client/src/components/jira/JiraView.tsx:21` ("the two in-page links" — Sessions' `Open Setup` is a
  third) and `:48` ("the Board page hands it to `useJiraBoard`" — both pages do), `client/src/components/SideRail.tsx:480` (same two-links wording). The spec's
  Constraints make following comments a requirement → one docs commit editing only those sentences.
- **I2** `docs/subsystems/jira.md:641` and `:644` — say the `jira-list` suite covers "the Board's issue List"; the issue-List cases are in `test/jira-board.test.tsx`
  (`describe('the issue List')`), `jira-list` covers only the Sessions page → name `jira-board` for the issue List.

### Minor

- **M1** `client/src/components/jira/JiraBoardPicker.tsx:9` — header cites no `.claude/DESIGN.md` subsection (board.md: "Every component cites its DESIGN.md
  subsection"); it lost the citation when moved out of `JiraBoardView`. Add `DESIGN.md §8.9.1`. `JiraSessionsView.tsx` cites only §8.0; its page is described in
  §8.9.1 — add it.
- **M2** `client/src/hooks/usePickedJiraBoard.ts:38` — "(Review Focus 3)" is carried over from an older plan; in this plan Review Focus 3 is the folded-child
  session. Drop or re-point the reference.
- **M3** ~19 edited comment lines across `client/src` exceed the 160-column width (`.prettierrc` printWidth 160; e.g. `JiraSessionList.tsx:39` at 228,
  `jira-view.ts:2` at 183, `JiraView.tsx` modal paragraph at 182, `useJiraListFilters.ts:6` at 178). In-place edits were not rewrapped. Rewrap the edited sentences
  only.
- **M4** `client/src/components/jira/JiraIssueList.tsx:427` — the Key cell is an `<a>` to Jira (ink2, not bold); `Main.dc.html:59` draws the key as plain 600-weight
  text with the whole row opening the modal. Defensible (it is the issue's one link out, tested as not opening Detail), but it is an unrecorded deviation from the
  picked mock — record it in the ui-verify doc or the DESIGN.md §8.9.1 List paragraph.
- **M5** `client/src/components/jira/JiraSessionsView.tsx:612-615` — with `jira.json` unreadable the band sub reads `jira.json cannot be read` without the reason and
  not in the `failing` red the Board page's sweep failures use; the reason appears only in the body, and only while All tickets is off. Spec only asks the band to
  "say what is wrong", which it does; consider `failing` for consistency.
- **M6** `client/src/lib/jira-list.ts:284-296` — `rowOpens` takes DOM `Element`s and calls `closest`, in a lib file whose header calls it "Pure". Moving it there gave
  both tables one home (good); the header's "Pure" now has one exception — say so, or note it beside the function.

## Declined to judge

- Badge click while a launch sheet or Detail is open on the Board page now clears them (page changes → `JiraView`'s `[page]` effects). Previously the badge kept the
  page `board`, so an open sheet survived. Set aside: navigating to another page clearing page-scoped modals is the existing, documented rule; spec silent.
- Sessions search text survives a badge click while already on Sessions (could hide a needs-you row). Set aside: per-mount search is what the spec chose, and the
  old List shared the same behaviour.
- Each Board ↔ Sessions switch remounts the page and re-fetches the board list (brief `loading…`). Set aside: a mount-time read, not a poller; same as Board ↔ Setup
  today; spec "loads the picked board the way the Board page does".
- Session table's Ticket column clipping at 1440 px (ui-verify "Pre-existing"). Set aside: CSS untouched by this branch, same on `main`.

## Fixes applied

- **I1** — fixed: `useJiraView.ts` header, `styles.css` (`.rail-badge`, session-table heading, `rowOpens` pointer), `jira-deck.ts`, `JiraView.tsx` (both sentences),
  `SideRail.tsx` now describe the three-page layout (Sessions' `Open Setup` named as an in-page link; both pages hand `nudge` to `useJiraBoard`).
- **I2** — fixed: `docs/subsystems/jira.md` names `jira-board` (`describe('the issue List')`, verified in the file) for the issue List; `jira-list` for the Sessions page.
- **M1** — fixed: DESIGN.md §8.9.1 cited in `JiraBoardPicker.tsx` and `JiraSessionsView.tsx` headers.
- **M2** — fixed: stale "(Review Focus 3)" in `usePickedJiraBoard.ts` re-pointed to "(the one stored pick)".
- **M3** — skipped — about 19 lines to rewrap across many files; more than a line or two each, and rewrapping is churn the instructions say not to do.
- **M4** — skipped — a decision on where to record the deviation (ui-verify doc or DESIGN.md), not a one-line comment fix.
- **M5** — skipped — would change rendered behaviour (band tone) and tests.
- **M6** — fixed: `lib/jira-list.ts` header now says "Pure apart from `rowOpens`, which reads DOM nodes".
