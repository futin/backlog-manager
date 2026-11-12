## Verdict: APPROVE WITH FIXES

Reviewed: `docs/superpowers/specs/2026-11-11-jira-run-on-parent-design.md` at `e74ef39d`, against the code at the same commit, the two picked mocks,
`prototype.cjs`, `CLAUDE.md`, `.claude/rules/board.md` and `.claude/DESIGN.md` §8.9.1 / §8.9.2. `spec:N` below is a line of that document.

## What this proposes

A sub-task's Detail gets two ways to its parent. The parent named in the head crumb and in the `Parent` fact becomes an in-board link that reads the
parent through the existing issue route and pushes it onto the Detail walk, so the head offers a way back. The sub-task's `Run ▾` menu gains a `Run on`
two-segment toggle (sub-task / parent) that always opens on the sub-task; with the parent picked, every row hands the parent's `JiraIssue` to the launch
sheet and is gated by the parent's own `runChipState`. A third piece, a one-line "parent is live" row in the sub-task's Agent band, mirrors the existing
"a child is underway" line. No server change, no new setting.

## How the existing system works, per this document

The team works sub-tasks on the parent story's branch, and the parent is usually on none of the user's boards. Detail shows the parent as plain text only,
so the one way to work on the parent's branch from a sub-task is the launch sheet's off-ticket `Continue`, which files the session under the sub-task and
shows its worktree on no card. `JiraRunMenu` is one split control that reads `runChipState` and calls `onPick`; `JiraView` holds the Detail walk
(`openChild` pushes, the head's `← KEY` pops) and hosts the single launch sheet. `GET /api/jira/issue/:key` answers a `JiraIssueDetail` for any key, on a
board or not, and the sessions payload carries links for every key.

All eight sections could be paraphrased.

## Critical

None.

## Important

1. **spec:86 — "both homes of `JiraRunMenu` (the card and the Detail)" is false; there are four call sites.**
   `client/src/components/jira/JiraCard.tsx:179`, `JiraDetail.tsx:306`, `JiraIssueList.tsx:177` (the List view's Run cell, drawn for a top — and a
   sub-task whose parent is off-board IS a top, which is this user's exact case) and `JiraSessionList.tsx:372` (an ended Sessions row). Because the toggle
   lives in the one component, it will draw in all four, and the spec says nothing about the last two. The Sessions row can also be a `stubIssue`
   (`client/src/lib/jira-list.ts:98-111`): its `type.subtask` is a regex over the snapshot's type name (`:89`) and its `parent` is
   `{ key, summary: '' }`, so the toggle's condition (spec:70) holds on data that was never read from Jira.
   Fix: name all four homes, say the toggle draws in each with the card's lazy read, say whether a stub issue gets it, and add a test case for the List
   cell and the Sessions row.

2. **spec:93 — the parent-live line is placed "under the band's sub-line", which exists in only one of the band's two shapes.**
   The sub-line (`.jira-detail-agent-sub`) is drawn only when the sub-task has no live session (`JiraDetail.tsx:335-353`); the live shape
   (`:312-333`) has a label row and session cards and no sub-line. Read literally, the line never draws while the sub-task itself has a live session —
   the same state in which spec:88-89 says the menu cannot open and the parent must be reached another way.
   Fix: say where the line sits in the live shape (or state outright that it is drawn only in the empty shape, and accept that against Goal 3, spec:23).

3. **spec:94, 96-97 — the line's copy is not exact and its stated precedent is wrong.**
   `<state>` is undefined: the mock reads `Running`, which is not a `STATE_LABEL` word (`shared/jira-sessions.ts:41-51` — `Working`, `Quiet`,
   `Waiting for plan approval`, …). "Show the newest and `+N`, as `ChildSessionLine` does" misdescribes it: that line shows the deck's lead
   (`deckOrder`, needs-you first, not newest — `client/src/lib/jira-deck.ts:122`) and reads `+N more` (`JiraDetail.tsx:656-657`), and its text is
   `<state> on <KEY> →` with no elapsed and no repo. The mock's dot is also an invented tone (`data-tone="ok"`, `prototype.cjs:63`), drawn grey.
   Fix: give the exact string per part (`STATE_LABEL[state]`, `elapsedSince`, `repoBasename`), say `+N more`, say which session leads, and list the
   mock's two differences (`Running`, the grey dot).

4. **spec:62-63 with spec:106 and spec:80-82, 143-145 — where a failed parent read is shown, when it clears, and whether it is retried are unspecified.**
   The "existing `role="alert"` line" is `useAction`'s `writeError` (`JiraDetail.tsx:189`, `:472-476`), and spec:106 forbids the read from using
   `useAction`. So a second source must feed that line, and the spec does not say which wins when a write refusal and a read failure both stand, or
   when the read failure clears (`writeError` clears when the next write leaves and on a key change, `:201-206`). The shared read says a landed answer
   is reused and a pending one joined, but not what a FAILED one does: a second click on the link, or a second pick of the parent segment, either
   retries or repeats the stored failure until the Detail closes.
   Fix: state the precedence, the clearing moments, and that a failed read is not cached (the next click or pick asks again).

5. **spec:78-79 — "the default row's sub-line names the target" conflates two rows.**
   `Work the ticket end to end` is the `execute` row's sub-line (`JiraRunMenu.tsx:85`); the `default` mark follows the setting and may sit on
   `context` or a skill row (`:83`, `:96`). With a skill as the default, the sentence either changes a slash-command sub-line or changes nothing.
   The mock happens to have `execute` as the default. It also truncates the new sub-line (`Work TIMIFY-27763 end to …`) beside the `default` mark,
   which the spec does not mention.
   Fix: say "the `execute` row's sub-line reads `Work <PARENT-KEY> end to end` while the parent is picked, whichever row is the default; every other
   sub-line is unchanged", and note the truncation.

6. **spec:15 and spec:34 against spec:10 — "the parent's card" is promised for a parent the spec says is on no board.**
   The deck and the shelves draw on-board tickets only (`.claude/DESIGN.md:594`, "not drawn at all while no ticket on the board has a live session";
   the fold goes to an on-board ancestor, `:584`). A session started on an off-board parent therefore shows on no card and no deck entry; it is visible
   in the sub-task's parent-live line and on Sessions with `All tickets`. The user rejected the off-ticket path because its worktree "does not show on
   either card" (spec:13), so this is the one consequence they should read before building.
   Fix: say in §1 or §7 where the parent's session is seen when the parent is off-board, and drop or qualify "the parent's card".

7. **spec:127 — test 12's expected branch default is wrong.**
   `{key}` renders lower-cased (`shared/jira-branch.ts:106`, `:130`), so the default pattern gives `p-1-<slug>`, not `P-1-<slug>`; and the seed is
   the mapped path's stored pattern when it has one (`JiraLaunchSheet.tsx:131`, `data.repoDefaults[repo]`), not always `{key}-{slug}`.
   Fix: `p-1-<slug>` under the default pattern, with the fixture stating no stored pattern.

8. **spec:77-78 — "`onPick` (and `onRun` above it)" must carry the issue: `onRun` already does.**
   `onRun: (issue, action)` in `JiraDetail.tsx:182` and `JiraView.tsx:83`; only `JiraRunMenu`'s `onPick: (action)` (`JiraRunMenu.tsx:60`) and the four
   callers' closures (`onPick={(action) => onRun(issue, action)}`) change.
   Fix: say that, and list the four closures.

## Minor

- spec:58 — the walk only pushes. Sub-task → parent → (Children row) sub-task → parent grows without bound, and when `back` is already the parent the
  link pushes a second copy instead of popping. Worth one sentence either way.
- spec:61-62 — opening the parent costs two Jira reads: the link's, then `JiraDetail`'s own `fetchJiraDetail` on the swapped key
  (`JiraDetail.tsx:211-217`). Fine, but say it is accepted.
- spec:70, 43 — `Run on` is already the title of `ui/RunOn`, the machine picker on the Launch and Orchestrate sheets (`ui/RunOn.tsx:55`, class family
  `.ui-run-on`). Same words, a different meaning; keep the new classes out of that family.
- spec:152 — "if `ui/` has one": it does, `ui/Segmented.tsx`. Its options are a one-line `label` plus `count` (`Segmented.tsx:32`), so the key-over-
  sub-line segment needs either a prop on the primitive or markup of its own; board.md's "one home in `components/ui/`" bullet applies to whichever.
- spec:153 against spec:118-120 — the tests fix `onPick(issue, action)` while §8 leaves the signature open; and "the menu takes a `target` prop" cannot
  work, since the toggle's state is inside the menu.
- spec:139-140 — a `starting` reservation is in the status' `live` map and never in the sessions payload (`JiraDetail.tsx:64-66`), so the parent-live
  line (spec:93, sessions payload only) can lag a Start; the gate (spec:83) is not affected, `runChipState` reads both.
- spec:81-85 — a failed read gets a visible note; `loading`, `live` and `no-repo` are a `title` only, which a touch screen never shows.
- spec:70-72 — nothing on the toggle's accessible state (`aria-pressed`, the group's name) or on the rows' names, which are identical for both segments
  because the sub-line is `aria-hidden` (`JiraRunMenu.tsx:105`).
- spec:54-56 — on a `stubIssue` the parent's summary is `''`, so the link text is the key alone until the detail lands.
- spec:3-4 — `prototype.cjs` writes `1-crumb-link.png` … `4-parent-live-line.png`; the directory holds three renamed files and no crumb-link shot. In
  `parent-live-line.png` the `Parent` fact is still plain text, against spec:56.
- spec:77 — "its `{key}-{slug}` branch default" is the default pattern's name; a path with a stored pattern seeds from that instead.

## Checklist

1. Facts — verified true: the crumb and `Parent` fact are plain text (`JiraDetail.tsx:248`, `:453`); `openChild` pushes (`JiraView.tsx:74`);
   `continueOffTicket` in `JiraBranchSection.tsx:85`; `JiraIssueDetail extends JiraIssue` (`shared/types.ts:998`); `type.subtask` exists (`:775`);
   `runChipState` keys the mapping by `issue.project.key` (`lib/jira.ts:841`); `landed()` re-asks the sessions payload (`JiraView.tsx:87-91`); a key on
   no board is a 200 with `boards: []` (`server/src/jira/jira.controller.ts:115`); `modalTree` on a key the snapshot lacks draws the direct children
   (`lib/jira.ts:402-421`). False: Important 1, 3, 8.
2. Contradictions and example values — Important 6, 7; test 2's `boom` is right (`lib/http.ts:17-21`).
3. Edge cases — Important 2, 4; Minor on the walk, the reservation and the stub.
4. Copy and mocks — Important 3, 5; Minor on `Run on`, titles and the mock files.
5. Scope — out-of-scope items are named; nothing in scope needs the server.
6. Hard rules — respected. The CSP line (spec:102) is stricter than CLAUDE.md's; `runChipState` stays the one gate (board.md, `Run ▾` bullet); the
   toggle sits inside the existing `Popover`, so the Escape stack is untouched; DESIGN.md §8.9.1 / §8.9.2 are updated in the same change (spec:104);
   tests flat in `test/` and the source-guard grep are both named (spec:112, 129).

Autopilot: no decision was needed and nothing was parked.

## Rulings

| id | outcome | evidence |
| --- | --- | --- |
| 1-1 | FIX | Four `<JiraRunMenu` call sites (JiraDetail:306, JiraCard:179, JiraIssueList:177, JiraSessionList:372); `stubIssue` in lib/jira-list.ts — §4.2 names all four homes and the stub, tests 13 |
| 1-2 | FIX | Live band (JiraDetail:312-333) has no sub-line — §4.3 places the line under the label row there, test 14 |
| 1-3 | FIX | `STATE_LABEL` (shared/jira-sessions.ts:41) has no `Running`; `ChildSessionLine` reads `+N more` — exact copy, lead rule and mock differences stated |
| 1-4 | FIX | Alert slot is `useAction`'s `writeError` (JiraDetail:189, :472) — read failure gets its own state and line, precedence, clearing, no caching; test 15 |
| 1-5 | FIX | `Work the ticket end to end` is the `execute` row's sub (JiraRunMenu:85) — sub-line rule now keyed to the `execute` row |
| 1-6 | FIX | Off-board parent has no card — §1/§2 say where its session is seen |
| 1-7 | FIX | `{key}` renders lower-cased (shared/jira-branch.ts:105) — test 12 expects `p-1-<slug>` with no stored pattern |
| 1-8 | FIX | `onRun` already `(issue, action)` (JiraView:83) — §4.2 says only `onPick` and its four closures change |
