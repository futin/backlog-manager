## Verdict: APPROVE WITH FIXES

Narrow re-check of the hunks changed by `09ada010` (plan review 1) in `docs/superpowers/plans/2026-11-11-jira-run-on-parent.md`. Only the changed
lines were reviewed: 30-31, 66-70, 80-82, 115-117, 123-128, 166-171.

## Critical

None.

## Important

1. **plan:125-126 — the two caller-closure cases are sent to the wrong suites, and the grep that is meant to find the second one finds nothing.**
   The plan says "one case in `test/jira-list.test.tsx` (a sub-task's List cell) and one in the suite that renders Sessions rows
   (`grep -l JiraSessionList test/`)". In the code:
   - `test/jira-list.test.tsx` IS the Sessions-page suite (its header, `test/jira-list.test.tsx:19`: "Jira › Sessions … moved here from the Board's
     List"), rendered through `JiraView`. `JiraSessionList` is drawn by `JiraSessionsView` (`client/src/components/jira/JiraSessionsView.tsx:93`).
   - The List's row cell is `JiraIssueList` (`client/src/components/jira/JiraIssueList.tsx:177`), drawn by `JiraBoardView`
     (`client/src/components/jira/JiraBoardView.tsx:246`), so its suite is `test/jira-board.test.tsx`.
   - No suite names `JiraSessionList` literally: none of `jira-board`, `jira-list`, `jira-detail`, `jira-setup`, `jira-sections`, `dialog-escape`,
     `jira-session-open` `.test.tsx` contains the string (they all render through `JiraView`), so the stated grep returns no file and the implementer
     must guess.
   - Consequences in the same task: the Files list (plan:96) names only `test/jira-board.test.tsx` as a modified suite, and Step 2 (plan:133) runs only
     `test/jira-run-menu.test.tsx`, so the two anti-goal-1 cases are never observed failing before the closures change.

   Fix: "List cell (`JiraIssueList`) → a case in `test/jira-board.test.tsx`; Sessions row (`JiraSessionList`, a `stubIssue` row with `All tickets` on) →
   a case in `test/jira-list.test.tsx`". Drop the grep. Add `test/jira-list.test.tsx` to the task's Modify list and both suites to Step 2's run.

## Minor

1. **plan:31 vs plan:88, 135-136, 175-176** — the new constraint says to run `test/fixture-clock.test.ts` "in Step 4 of every task that creates or
   extends" a `.tsx` suite, but none of the three Step 4 command lists names it. Add it to each list so the step and the constraint agree.
2. **plan:83, 167 vs plan:30** — "started 10:00 and 10:05" reads as wall-clock literals, next to a new constraint that says "never date literals".
   The guard itself would not fire (its keys are `created|updated|lastCommit|started`, `test/fixture-clock.test.ts:39`, and `startedAt:` does not
   match `\bstarted\s*:`), but the wording invites an absolute stamp. Say "five minutes apart, relative to now" (cf. `hoursAgo`,
   `test/jira-list.test.tsx:48`).
3. **plan:167** — the fixture discriminates state and repo well (`plan`/`web`, `quiet`/`api`, `working`/`microservice`; all three are valid
   `JiraSessionState`s, `shared/jira-sessions.ts:7`). It does not say the payload order. `ticketSessions` sorts by `startedAt`
   (`client/src/lib/jira-sessions.ts:185`); to tell "newest" from "first in the payload" the newer `P-1` link should be listed after the older one.
4. **plan:69-70** — "its reference moves to the new key" is stated behaviour with no case: plan:81 pins only the `idle` reset and the `P-2` fetch. A
   one-line addition would pin it (after the rerender to `P-2`, a fresh hook on `P-1` that asks fetches `P-1` again).
5. **plan:170-171** — both halves of the per-surface case use the message `boom`. "No pre-filled `boom` note" is checked while the menu's own read is
   pending, so it holds, but a second message for the link's failure (e.g. `link-boom`) would make a leak in either direction unmistakable.
6. **plan:125-126** — the Sessions-row case needs a link whose snapshot is a sub-task with a parent; the suite's `link()` helper hard-codes
   `type: 'Task', parentKey: null` (`test/jira-list.test.tsx:120`). Worth a word that the helper gains two optional fields.

## Verified, no finding

- plan:30-31 — `daysAgoStamp` / `daysAgoDate` exist (`test/helpers/dates.ts:28,33`); `test/fixture-clock.test.ts:62-66` scans every
  `test/*.test.tsx`; the rule is in `.claude/rules/tests.md`.
- plan:66-67 — the menu component stays mounted with its card and only the panel is conditional (`JiraRunMenu.tsx:156`), so a hook in the component
  body would hold the landed read for the card's lifetime; putting it in the open panel matches spec §7 line 168 and §4.2 line 88, and plan:128 pins it.
- plan:68-70 — `JiraView` renders `JiraDetail` with no `key` (`client/src/components/jira/JiraView.tsx:107-116`); the launch sheet beside it is keyed
  (`:121`), so the contrast is real. plan:81 pins the reset.
- plan:80, 82 — two keys and two surfaces, each with distinct values; both discriminate a module-level shared state.
- plan:115-117 — the skill fixture matches the row mapping (`action: { skill: k.id }`, `label: k.name`, `JiraRunMenu.tsx:88`), and
  `test/jira-board.test.tsx:887` is the cited `SKILL` constant. Distinct id, name and prompt tell the three apart. Matches spec §6 case 6.
- plan:123-124 — `stubIssue(key, { summary, type, parentKey }, site)` is the real signature (`client/src/lib/jira-list.ts:98`); `Sub-task` reads as
  `subtask: true` (`:89`) and the parent summary is `''` (`:111`).
- plan:95 — the four closure sites are at the stated lines (`JiraDetail.tsx:306`, `JiraCard.tsx:179`, `JiraIssueList.tsx:177`,
  `JiraSessionList.tsx:372`); the `(_i, a) => onRun(top, a)` mutant in plan:127 is the List cell's own variable name.
- plan:128 — consistent with spec §4.2 line 88 ("as does closing and reopening the menu and picking it") and scoped to the card home, where no Detail
  hook holds the key.
- plan:166-168 — expected text `Parent P-1 · Working · microservice →` matches spec §4.3 and `STATE_LABEL.working` (`shared/jira-sessions.ts:47`);
  `+1 more` matches spec §6 case 14.
- plan:170-171 — matches spec §4.2 lines 88-90 and §6 case 16.

## Rulings

| id | outcome | evidence |
| --- | --- | --- |
| 2-1 | FIX | `test/jira-list.test.tsx:18` is the Sessions-page suite; `JiraIssueList` is drawn at `JiraBoardView.tsx:246` (board suite). Cases re-homed, grep dropped, `jira-list.test.tsx` added to Modify and both suites to Step 2. |
