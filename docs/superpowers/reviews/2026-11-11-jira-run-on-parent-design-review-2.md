## Verdict: APPROVE WITH FIXES

Reviewed: `docs/superpowers/specs/2026-11-11-jira-run-on-parent-design.md` at `2502276a` (after "address spec review 1"), against the code at the same
commit, the mocks `run-on-toggle.png` and `parent-live-line.png`, `prototype.cjs`, `CLAUDE.md`, `.claude/rules/board.md` and `.claude/DESIGN.md` §8.9,
§8.9.1 and §8.9.2. `spec:N` is a line of that document.

## What this proposes

A sub-task's Detail gains two routes to its parent story, which owns the branch. The parent named in the head crumb and the `Parent` fact becomes an
in-board link: a click reads the parent through the existing issue route and pushes it onto the Detail walk, so the head offers `← <sub-task>`. The
sub-task's `Run ▾` menu, in all four places it is drawn, gains a `Run on` two-segment toggle that always opens on the sub-task; with the parent picked,
every row hands the parent's `JiraIssue` to the launch sheet and is gated by the parent's own `runChipState`. A one-line "parent is live" row in the
sub-task's Agent band shows the parent's newest live session and opens the parent's Detail. No server change, no new setting.

## How the existing system works, per this document

Sub-tasks are assigned, but every sub-task is worked on the parent story's branch, and the parent is usually on none of the user's boards. Detail shows
the parent as plain text only, so the one way to work the parent's branch from a sub-task is the launch sheet's off-ticket `Continue`, which files the
session under the sub-task. `JiraRunMenu` is one split control drawn by four callers; it reads `runChipState` and calls `onPick(action)`, and each caller
closes over its own issue to call `onRun(issue, action)`. `JiraView` holds the Detail walk (`openChild` pushes) and the one launch sheet;
`GET /api/jira/issue/:key` answers a `JiraIssueDetail` for any key, and the sessions payload carries every key's links.

All eight sections could be paraphrased.

## Critical

None.

## Important

1. **spec:17 (and spec:16) — "it is seen … on the Sessions page" is true only with `All tickets` on, which is off by default.**
   `buildListRows` skips a link whose ticket is not on the picked board unless `allTickets` (`client/src/lib/jira-list.ts:136-137`), and
   `DEFAULT_LIST_FILTERS.allTickets` is `false` (`:54`). For the exact case the spec is written for (parent on no board), the parent's session is on no
   card, no deck entry and, by default, no Sessions row. Review 1's finding 6 said "on Sessions with `All tickets`"; the fix dropped the qualifier.
   The user rejected the off-ticket path because the session "does not show on either card" (spec:13), so the one sentence that says where the new
   session IS seen has to be exact.
   Fix: "on the Sessions page with `All tickets` on".

2. **spec:100 — which issues draw the parent-live line is not stated.**
   §4.3 says "in a sub-task's Detail". The spec has two different gates for "has a parent": `type.subtask && parent !== null` for the toggle (spec:73)
   and `parent !== null` alone for the link (spec:54, 69), and §7 (spec:150) names the gate for the toggle and the link only. A story under an epic with
   a live session on the epic either draws the line or does not, and no test decides it (test 11, spec:136, uses a sub-task; test 3/4 cover the link and
   the toggle only). If it does draw on a non-sub-task, the empty band can hold both `ChildSessionLine` (`JiraDetail.tsx:348-350`) and this line, and
   spec:101 ("beside where `ChildSessionLine` sits") gives no order.
   Fix: state the condition (the toggle's or the link's), add it to §7, and if it is the link's, say which line comes first.

3. **spec:85-87 against spec:63-66 and spec:159-161 — a failed parent read inside the menu has no retry and no stated reach.**
   The read is one shared read per parent key (spec:159-161), a failed one "is never cached" (spec:66), and the link's failure "clears on the next click
   of the link". For the menu, spec:86-87 says only that the rows are disabled with the sentence as title and a note under the toggle. Unstated:
   (a) what re-asks — the parent segment is already the picked one, so "picking the parent segment reads the parent" (spec:85) has no second pick short of
   toggling to the sub-task and back, or closing the menu; (b) whether a failure raised by the Detail's own menu also draws the Detail's `role="alert"`
   line (the state is shared, and spec:63-65 calls it "the read's own state"), and the reverse — whether a link failure already standing shows in the
   menu's note before any pick. Tests 2 and 15 (spec:125, 143) cover the link only; no test covers the menu's failed read at all.
   Fix: say what retries in the menu (a click on the already-picked parent segment reads again, or reopen), say whether the failure is per surface or
   shared, and add one test case for the menu's failed read.

## Minor

- spec:91-93, test 13 (spec:139) — "the Sessions row" is an ENDED row only: `canRun = row.ended && … runChipState(…) !== 'live'`
  (`client/src/components/jira/JiraSessionList.tsx:315`, `:372`). Test 13's fixture must be an ended link on a mapped project, or no menu draws
  (a `no-repo` chip opens nothing, `JiraRunMenu.tsx:147-148`, `:156`).
- test 7 (spec:131) — the parent's gate needs the parent's `project` (`runChipState` checks `no-repo` first, `client/src/lib/jira.ts:841-842`), so the
  rows read `a session is running on P-1` only after the read landed and with the project mapped; the case should say so. Which title wins while the
  read is pending and `status.live[P-1]` is already set (`loading P-1…` or the live title) is not stated (spec:85-89).
- spec:86 — the loading title is written with a literal key (`loading TIMIFY-27763…`); test 6 (spec:129) has `loading P-1…`. Write it
  `loading <PARENT-KEY>…` like the other titles.
- spec:169 against spec:81 and tests 5, 6, 13 — §8 still leaves `onPick`'s shape to the builder ("or the menu takes a `target` prop") while §4.2 and
  three tests fix `onPick(issue, action)`; the toggle's state is inside the menu (`JiraRunMenu.tsx:64`), so a `target` prop cannot carry it. Carried
  from review 1, not addressed.
- spec:59-60 — the walk only pushes (`JiraView.tsx:74`). Opened parent → Children row → sub-task → parent link pushes a third entry when `back`
  (`JiraView.tsx:76`) is already the parent, and the loop is unbounded. One sentence either way. Carried from review 1.
- spec:62-67 — opening the parent costs two reads of the same key: the link's, then `JiraDetail`'s own keyed `fetchJiraDetail` on the swapped issue
  (`JiraDetail.tsx:211-217`); a Start through the parent segment adds the launch sheet's (`JiraLaunchSheet.tsx:156`). Say it is accepted.
- spec:73, 92-93 — in the Detail the menu is handed `issue`, the card's or the stub's copy (`JiraDetail.tsx:306`), while the crumb reads `src`, the
  fresh detail (`:236`, `:248`). On a stub whose snapshot type name is not `Sub-task`/`Subtask` (`stubType`, `client/src/lib/jira-list.ts:88-90`) the
  Detail shows the parent link and no toggle even after the detail has landed with `type.subtask: true`. Either accept it in a sentence or say the
  Detail's menu reads the fresh copy. `stubType`'s header says "nothing acts on a stub's type" (`:86`); this change makes that false and the comment
  should follow.
- spec:94 against spec:85 — "Outside the Detail the parent read happens only when the parent segment is picked" implies the Detail may read earlier,
  but spec:85 says the pick is what reads, everywhere. Say whether the Detail reads on open, on menu open, or on the pick (it decides whether the
  parent segment's sub-line reads `parent` or `parent story` when the menu first opens, spec:74-75).
- spec:12 — `continueOffTicket` is defined in `client/src/lib/jira.ts:1273`; `JiraBranchSection.tsx:85` is its caller.
- spec:16-17 — the deck and shelves are DESIGN.md §8.9.1 (`.claude/DESIGN.md:594`, `:598`), not §8.9.
- spec:114-115 — the parenthesis lists the toggle and the link; the parent-live line changes §8.9.2's Agent column paragraph
  (`.claude/DESIGN.md:620`) too. `board.md`'s `Run ▾` bullet (`.claude/rules/board.md:115-117`) still describes two homes; not a rule broken, but it is
  the mechanism's home and will read stale.
- spec:104-105, 146 — the listed differences from `parent-live-line.png` omit one: the mock's `Parent` fact is plain text (the prototype's lookup
  missed it, `prototype.cjs:19-20`), against spec:57. `/ui-verify` against that mock will report it unless it is listed.
- spec:44, 73 — `Run on` is already the label of `ui/RunOn`, the machine picker (`client/src/components/ui/RunOn.tsx:55`). Same words, another
  meaning; keep the new classes out of that family. Carried from review 1.
- spec:63 — "marked busy" names no attribute (`aria-busy`, `disabled`); spec:73-75 names no accessible state for the segments. Carried from review 1.
- spec:95-96 — only the `live` consequence is spelled out. A sub-task whose own project is unmapped (`no-repo`) cannot reach a parent in a mapped
  project either (spec:157 allows another project); Doorway 1 is the route there too.
- spec:106, 155-156 — a `starting` reservation is never in the sessions payload (`JiraDetail.tsx:64-66`), so the line can lag the gate, which reads
  `status.live` (`client/src/lib/jira.ts:843`). Harmless here since `landed()` runs after the Start answered (`JiraView.tsx:87-91`). Carried.

## Checklist

1. Facts — verified true: crumb and `Parent` fact are plain text (`JiraDetail.tsx:248`, `:453`); `openChild` pushes and `onRun` is `(issue, action)`
   (`JiraView.tsx:74`, `:83`); `onPick` is `(action)` and the four callers close over their own issue (`JiraRunMenu.tsx:60`, `JiraDetail.tsx:306`,
   `JiraCard.tsx:179`, `JiraIssueList.tsx:177`, `JiraSessionList.tsx:372`); `execute`'s sub-line is `Work the ticket end to end`
   (`JiraRunMenu.tsx:85`); the live and no-repo titles (`:78-80`); `runChipState`'s signature and its `project.key` lookup
   (`client/src/lib/jira.ts:836-846`); `JiraIssueDetail extends JiraIssue` (`shared/types.ts:998`); `type.subtask` (`:775`); a key on no board is 200
   `boards: []` (`server/src/jira/jira.controller.ts:113-133`); `stubIssue`'s guess and empty parent summary (`client/src/lib/jira-list.ts:88-111`);
   the live band has no sub-line (`JiraDetail.tsx:312-334`); `ChildSessionLine` uses `ui-stripe-dot` + `sessionTone` and `+N more` (`:655-657`);
   `STATE_LABEL` has no `Running` (`shared/jira-sessions.ts:41-51`); `ticketSessions().live` is newest-start first (`client/src/lib/jira-sessions.ts:185`);
   `{key}` renders lower-cased and the default pattern is `{key}-{slug}` (`shared/jira-branch.ts:21`, `:130`; `client/src/lib/jira.ts:1113`);
   `failureOf` gives `boom` for test 2 (`client/src/lib/jira.ts:944-947`); `landed()` re-asks the sessions payload (`JiraView.tsx:87-91`).
   False or imprecise: Important 1; Minor on spec:12 and spec:16-17.
2. Contradictions and example values — Minor on spec:169 vs spec:81, spec:94 vs spec:85, spec:86 vs test 6. Test 12's `p-1-<slug>` recomputed: right.
3. Edge cases — Important 2, 3; Minor on the walk, the stub, the pending-vs-live title, `no-repo`, the reservation.
4. Copy and mocks — the line's copy, the `execute` sub-line and the three mock differences are exact and match the mocks; one un-listed mock
   difference (Minor).
5. Scope — out-of-scope items are named; nothing in scope needs the server or a new setting.
6. Hard rules — respected. CSP: classes in `styles.css`, stricter than CLAUDE.md's CSSOM rule (spec:112-113). `runChipState` stays the one gate and the
   control is never hidden (board.md `Run ▾` bullet). The toggle sits inside the existing `Popover`, so the Escape stack and its composer count are
   untouched. One `Modal`, the walk swaps its issue (spec:59). The parent read is a one-shot read, not a poller, and stays off `useAction` (spec:116).
   DESIGN.md is updated in the same change (spec:114). Tests flat in `test/` and the source-guard grep are named (spec:122, 145). No server, item-file
   or git write.

Autopilot: no decision was needed and nothing was parked.

## Rulings

| id | outcome | evidence |
| --- | --- | --- |
| 2-1 | FIX | `DEFAULT_LIST_FILTERS.allTickets: false` and the off-board skip (lib/jira-list.ts:54, :136-137) — §1 qualified |
| 2-2 | FIX | Line's condition now the toggle's (`type.subtask && parent`), order vs `ChildSessionLine` stated, §7 and test 17 |
| 2-3 | FIX | Menu failure retry (re-click picked segment), per-surface display of a shared read, test 16 |
