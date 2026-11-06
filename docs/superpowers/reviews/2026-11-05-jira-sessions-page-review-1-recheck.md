# Jira sessions page — plan review 1, re-check

Scope: only the lines `git diff HEAD~1 -- docs/superpowers/plans/2026-11-05-jira-sessions-page.md` touches (commit `7fbb0dc8 docs: address plan review 1`).
Spec read for the touched parts: `docs/superpowers/specs/2026-11-05-jira-sessions-page-design.md` L57-70 (List order, Session cell, rolled-up Updated),
L80 (`Run ▾` on Sessions rows), C1/C9.

## Verdict: APPROVE WITH FIXES

Two Important findings, both in test guidance; no Critical. Everything else the diff states checks out against the code.

## Verified (no finding)

| Plan line | Claim | Evidence |
| --- | --- | --- |
| 48 | `JiraView.tsx` needs no edit in Task 1: `page === 'setup' ? … : <Board>` draws Board for any other page | `client/src/components/jira/JiraView.tsx:85` is exactly that ternary; `RAIL_JIRA_LABEL: Record<JiraPage,…>` at `SideRail.tsx:487` is the only exhaustive `JiraPage` map and Task 1 already lists it |
| 77 | `.claude/rules/board.md` L21 and `hooks/useDialogEscape.ts` ~L48 both name `components/jira/JiraBoardView.tsx` as the picker's `Popover` composer | `.claude/rules/board.md:21`, `client/src/hooks/useDialogEscape.ts:48` |
| 87 | `BoardPicker`'s `current` is non-null | `JiraBoardView.tsx:273` (`current: JiraBoardStatus`); `board` is null only while unreadable or with no boards (`:124`, `:162`), so "draw once `board` is" agrees with Task 3's `boards.length > 0 && unreadable === null` |
| 141-142 | the two `jira-board` cases fail before Task 3's Step 3 | search label is `view === 'list' ? 'Search sessions' : 'Search issues'` (`JiraBoardView.tsx:193`); FilterBar is behind `view === 'board' &&` (`:201`) |
| 168-170 | `rolledUpdated` → `string \| null`, `sortTops` parses it with `null → 0`, today's "unparseable is oldest" | `updatedMs` at `client/src/lib/jira.ts:107-109` maps NaN to 0; `sortTops` at `:277-281`; the three existing `sortTops` cases (`test/jira-lib.test.ts:755-775`) hold under that implementation (P1 child 0 h lifts P; key tie-break untouched; `not a date` with no children → `null` → 0 → last) |
| 170, 181 | `elapsedSince(rolled, now)` is guarded for `null` | `elapsedSince(started: string, …): string \| null` at `client/src/lib/item-age.ts:65` — needs the non-null guard the plan states |
| 175 | `issueCellWord` `ended → ''` is never reached | `boardAgents` skips `link.state === 'ended'` / `endedAt !== null` at `client/src/lib/jira-deck.ts:81`; `JiraSessionState` has nine members (`shared/jira-sessions.ts:7`), so "nine states except `ended`" = eight cases |
| 192-193 | `rolledUpdated` unit cases | `n(key, parent, hoursAgo, over)` and `fold()` helpers exist in `test/jira-lib.test.ts` (used at `:757-770`); the four cases are distinct and discriminate (parseable child over unparseable top; all-unparseable → `null`) |
| 195-196 | `['PAY-120', 'PAY-180', 'PAY-190']` is the GROUP fixture's `sortTops` order | GROUP at `test/jira-board.test.tsx:541-574`: PAY-120 rolls up to PAY-162's `daysAgoStamp(0)`, PAY-180 is 1 d, PAY-190 is 2 d — recomputed, matches |
| 139 | `Work it end to end` is a `Run ▾` pick | `JIRA_BUILTIN_LABELS` (shared) drawn by `JiraRunMenu.tsx:90`; `Run <key>` button exists on ended rows only (`test/jira-list.test.tsx:292-296`) |
| 139-140 | the new launch-sheet case is not a duplicate | the existing case at `test/jira-list.test.tsx:299-326` opens the `Run ▾` panel and Escapes without picking |
| — | no stale `rolledUpdatedMs` / `rolled-up ISO` left in the plan | `grep` over the plan: none |

## Findings

### Important

- **[I] plan:140 — "a dialog named for the launch sheet (as `test/jira-launch.test.tsx` finds it)" points at the wrong finder.** That file finds the
  sheet with an unnamed `screen.getByRole('dialog')` (`test/jira-launch.test.tsx:217`), which only works because nothing else is open there; on the Sessions
  page the `Run ▾` popover (`Run menu`) and Detail are dialogs too, so an unnamed query is ambiguous or matches the wrong one. The sheet's accessible name is
  `run <key>` (`client/src/components/jira/JiraLaunchSheet.tsx:270` → `client/src/components/ui/FormSheet.tsx:67`).
  → Say: `screen.findByRole('dialog', { name: 'run PAY-131' })` is open (the named-finder shape `test/jira-list.test.tsx:325` already uses) and
  `queryByRole('dialog', { name: /^PAY-131 / })` (Detail) is null.

- **[I] plan:195-197 — the order assertion cannot fail against an unsorted render.** `['PAY-120', 'PAY-180', 'PAY-190']` is also GROUP's input order, and
  `fold.tops` is "in the input list's order" (`client/src/lib/jira.ts:188`), so a `JiraIssueList` that draws `fold.tops` without `sortTops` passes. The
  added case ("an In Progress or Done top is the newest … the List puts it first") discriminates from the Board's column order but says nothing about
  where that top sits in the served list — served first, it passes unsorted too.
  → State that the extra case serves the newest top LAST in the list (e.g. an In Progress top at `daysAgoStamp(0)` appended after PAY-190) and asserts it
  is the first row; that one case then discriminates from both input order and column order.

### Minor

- plan:141-143 — the two `jira-board` cases are filed under Task 3, but Step 2's red run is `pnpm exec jest test/jira-list.test.tsx` only; add
  `test/jira-board.test.tsx` to Step 2 so the C1 cases get their red proof (Step 4 already runs it green).
- plan:48 (context, not a diff change) — `client/src/hooks/useJiraPage.ts:6,12` and `JiraView.tsx:18` still say "two pages" / "`board` or `setup`"; Task 3
  rewrites `JiraView`'s header, nothing lists `useJiraPage.ts`'s comment. Worth a line in Task 1's Files.
- plan:170 — "`sortTops` parses it" is the right design (one source for sort and column); note for the implementer that the key tie-break and the
  `Math.max` over children are now `rolledUpdated`'s, so `updatedMs` stays private and is called from one place.

## Checklist

1. Values — every copy string and expected value in the diff matches spec and code (table above). One wrong test finder (I-1).
2. Reality — every path, name and line reference in the diff exists; fixture-derived sort order recomputed and correct.
3. Interfaces — `rolledUpdated` replaces `rolledUpdatedMs` everywhere; no old names remain.
4. Tests — the `rolledUpdated` and C1 cases are red before implementation and discriminate; the List order case does not (I-2).
