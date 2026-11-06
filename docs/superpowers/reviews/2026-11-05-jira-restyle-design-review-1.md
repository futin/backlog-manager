# Review 1 — `docs/superpowers/specs/2026-11-05-jira-restyle-design.md` (2026-11-05)

Reviewer: fresh subagent (Fable), checklist as dispatched. Every claim below was checked against the code by reading it; `file:line` cites the repo at
`99ac9481`. Lines in `<doc>:<line>` are the spec's.

## Verdict: REVISE

One Critical: the spec rebuilds `JiraRunMenu` and says it has two homes, but it has three — the Sessions page's rows compose it too, a surface §2 names as
not touched, and a suite §6 does not list pins the old behaviour there. Fourteen Important findings, most of them a false stated fact or a test the
suite would go red on that §6 does not name; none needs a redesign. The contrast arithmetic, the guard descriptions (uppercase, 11 px floor, primitives
block, dialog count), the eleven fact rows, the Run menu's ARIA handles and the `runChipState` states all check out.

## Critical

- **[C] spec:71-72, 29-32, 203, 221-247 — `JiraRunMenu` has a THIRD composer the spec does not know about, on a surface it declares out of scope.**
  `client/src/components/jira/JiraSessionList.tsx:326` renders `<JiraRunMenu issue={issue} onPick=… />` on an ended Sessions row (`canRun`), and
  `test/jira-list.test.tsx:290,308` find it by `Run PAY-131` while `:496-501` click `Run PAY-131` and then expect a dialog named `Run menu`. §4.1 line 71
  says "One group" and line 74 names only the card and the dialog as homes; §2 line 31 says Sessions is not touched; §6 lists `jira-board`, `jira-detail`
  and `jira-launch` only. Built as written, the Sessions row gets the ink-filled split button, its left click opens the launch sheet instead of the menu,
  `jira-list.test.tsx:496-501` goes red, and a surface the spec promised to leave alone changes shape. → Name the third home: either the Sessions row adopts
  the split too (strike "Sessions" from the non-goal's Run cell, add `test/jira-list.test.tsx` to §3 line 65 and §6 with the same left-half/`Run options`
  split as the detail cases), or `JiraRunMenu` gains a `home="row"` that keeps the outlined 28 px chip until the app spec's §4.3 restyles Sessions. The
  first is simpler and matches `2026-11-05-app-restyle-design.md:94,119`, which already assume the split on list rows.

## Important

- **[I] spec:132 (also 157-159, 189) — the status categories are not `todo` / `doing` / `done`.** `shared/types.ts:733` is
  `JiraStatusCategory = 'new' | 'indeterminate' | 'done'`; `todo` / `doing` / `done` are `JIRA_COLUMNS` slugs (`client/src/lib/jira.ts:87-91`). "the dot
  `--ink3` for the `todo` category" names a value a `JiraIssue.status.category` never holds, and §4.4's "LANDING status's category tone" reads
  `JiraTransition.to.category`, the same three keys. → State the mapping once: `new` → `--ink3`, `indeterminate` → `--amber-solid`, `done` →
  `--green-solid`, resolved through `JIRA_COLUMNS` (or `columnOf`) so the dot and the column agree by construction.
- **[I] spec:60 — the eighth dialog is `ReleasesDrawer`, not `Confirm`.** `.claude/rules/board.md:12-19` lists the eight (two `Modal`s, five `FormSheet`s,
  `ReleasesDrawer`) and says `Confirm` "paints no scrim and is not counted"; `test/dialog-count-docs.test.ts:46` pins the same eight names. → Replace
  `Confirm` with `ReleasesDrawer`.
- **[I] spec:194 vs §6:223-228 — dropping the category word (`· in progress`) goes red on four assertions §6 does not list.**
  `test/jira-detail.test.tsx:235,421,437,446` assert `fact('Status')` has text `In Review · in progress`. → Add them to §6's `jira-detail` bullet (the
  Status fact reads the raw name alone, with a dot element carrying the tone class).
- **[I] spec:104 vs §6 — the footer's new wording goes red on `test/jira-board.test.tsx:831`**, which pins `getByText('opens the launch sheet')`. → List it
  in §6 (`Every choice opens the launch sheet first`).
- **[I] spec:188-189 — "the landing status's name" drops a behaviour the code and a test hold.** `transitionOptions` (`client/src/lib/jira.ts:849-853`)
  names a row by the TRANSITION's own name when two transitions land in one status, and `test/jira-detail.test.tsx:865-878` pins `In Testing`, `In Review`,
  `In Review (2)`. The popover as specified would draw two identical `In Review` rows. → Say the rows reuse `transitionOptions` (same fallback), and carry
  that case into §6.
- **[I] spec:192-194 — the chip's disabled set omits a write in flight.** Today both controls disable while `busy` (`JiraDetail.tsx:352`
  `disabled={busy || !moveReady}`, `:359` for `Assign to me`), so a second pick cannot post while the first is out. The spec lists only the two titled
  blocks and the loading case. → Add "and while a write is out, as the select is (no title)".
- **[I] spec:240 and 79-81 — the live tint has no path onto the primitive.** §6 pins `.ui-split[data-state="live"]`, but `SplitChip`'s props are
  `disabled`, `dashed`, … with no live/tone state, and today `data-state` sits on the Jira wrapper `.jira-run` (`JiraRunMenu.tsx:109`;
  `styles.css:1288` `.jira-run[data-state='no-repo'] > button`). A rule `.ui-split[data-state=…]` must live inside the primitives block (guard 7,
  `test/design-guards.test.ts:366-400`) yet the state is Jira's. → Decide: a `tone?: 'live'` prop on the primitive (declared in the block, then the PINNED
  selector is `.ui-split-live` or similar), or a Jira-local rule `.jira-run[data-state='live'] .ui-split` outside the block (then PIN that selector). Say
  the same for `dashed`, which today is the wrapper's doing, not the chip's.
- **[I] spec:58 vs 236 — §3 names four homes of "seven composers", §6 three.** `docs/subsystems/invariants.md:2242` says "seven composers since Jira
  phase 5" and `.claude/DESIGN.md:415` too (§7 covers DESIGN; invariants.md is covered nowhere in §6). → Add invariants.md to §6's dialog-count bullet, or
  drop it from line 58.
- **[I] spec:74 — "`home` keeps deciding the size, as it does today" is false.** `JiraRunMenu.tsx:117` is `size={28}` in both homes; `home` only chooses
  the panel width and the scroll-into-view. → "`home` decides the size — new: 32 in the dialog".
- **[I] spec:118-119 — "As today … after a pick the menu closes and focus returns to the chevron half" is not today's behaviour.** `pick`
  (`JiraRunMenu.tsx:100-103`) closes and calls `onPick`; `Popover` restores focus to the anchor on ESCAPE only (`ui/Popover.tsx:63-70`), so after a pick
  focus falls to `body`. → State it as a new requirement and add the case to §6 (and say the Move-to popover does the same).
- **[I] spec:76-77 — the tint guard does NOT read `color-mix(…, transparent)` as malformed.** `test/daylight-contrast.test.ts:138` accepts
  `transparent` as the surface, `:155-168` treats it as a tint, and `:216` measures it over all four surfaces. → Drop the claim; the real reason to avoid it
  is that an `--on-accent` mix would become a tint site measured on every surface and fail there.
- **[I] spec:97-98 — "an even split of a 1000 px shell" is wrong.** `.ui-modal-split` is `width: min(1320px, …)` with `grid-template-columns:
  minmax(0, 1.05fr) minmax(0, 1fr)` (`client/src/styles.css:3715-3718`). The conclusion (300 px fits) holds; the numbers do not. → Correct them.
- **[I] spec:93 — "the deck card already carries the pulse" is false.** The deck card's strip is `ui/LiveStrip` (`JiraAgentDeck.tsx:66` →
  `ui/LiveStrip.tsx:18`, `.board-card-live hatch`), which has no animation; the only breathing dots are `JiraSessionList.tsx:281` and
  `JiraIssueList.tsx:94` (`<Dot breathe>`), on list rows. → Say "no pulse: §8.8's one motion is the list rows' breathing dot" (the decision stands).
- **[I] spec:65 and 229 — `test/jira-launch.test.tsx` holds none of the Run control's selectors.** No `Run <key>`, no `Run menu` in it (its `SKILL`
  fixture at `:31` feeds the sheet's Action select); the suite with them is `test/jira-list.test.tsx` (see the Critical). → Replace `jira-launch` with
  `jira-list` in §3 line 65 and §6 line 229.

## Minor

- spec:3-4 — "version 5": `00-mock-audit.md:33-35` says `Board.dc.html` and `Modal.dc.html` were re-copied from version 9.
- spec:170 vs 211 — the robot glyph is "16 px" in §4.4 and in the "14 px box" list in §5; pick one.
- spec:189-190 — "in Jira's order" and "drawn first" in one sentence; say "the current status's row first (when offered), then the rest in Jira's order".
- spec:158-159 — the count pill "on `--strip`": `Pill` `neutral` is `--strip-hi` (`styles.css:3416`) and takes no className; say whether it is a page rule
  under `.board-col[data-tone] .board-col-pill` or a new `Pill` tone. The page-rule route is DESIGN's "page CSS lays a primitive out" line stretched to a
  colour; the tone route touches a primitive the Board also uses.
- spec:125-127, 234 — the tile tone should follow the glyph's precedence: `ui/JiraTypeIcon.tsx:5-13` decides subtask → level ≥ 1 → name, so a sub-task
  whose type is named `Bug` draws the subtask glyph; "by `type.name` and `subtask`" should read "by the same test the glyph uses".
- spec:135-137 — the card's repository fact needs `status.repos[issue.project.key]` through `useJiraContext` (`JiraCard` reads no context today;
  `JiraRunMenu.tsx:65` does); name the source.
- spec:243 — guard 7's family list is hard-coded (`test/design-guards.test.ts:310-331`); `.ui-split` must be appended to `FAMILIES` or the "declared once"
  case never sees it.
- spec:238 — the PINNED case is titled "the ten tint sites" (`test/daylight-contrast.test.ts:392`, comment at `:388`); seven more makes it seventeen.
- spec:83-84 — `onPick(row)`: the prop is `onPick(action: JiraAction)` (`JiraRunMenu.tsx:64`).
- spec:94, 216 — `pollAge` (`client/src/lib/tracker.ts:37`) is what the deck uses (`JiraAgentDeck.tsx:66`), while the detail's `sessionLine` uses
  `elapsedSince` (`JiraDetail.tsx:275`); §5 leaves it open — fine, but say the deck's is the precedent.
- spec:89 — no-repo "both halves disabled": today the chip is enabled and merely opens nothing (`JiraRunMenu.tsx:121` `disabled={state === 'live'}`), and
  `test/jira-board.test.tsx:761-767` clicks it. Firefox fires no hover on a disabled button, so the `title` that names Setup is unreachable there; consider
  enabled-but-inert (as today) or `aria-disabled`. Taste.
- spec:49-56 — verified: `text-transform: uppercase` in exactly `.rail-kicker` (`design-guards.test.ts:212-214`), 11 px floor (`:193-197`), tint regex and
  bare `var(--amber)` ban (`daylight-contrast.test.ts:138,416`).
- Contrast recomputed from `shared/theme.css:167-171` (daylight): `--red` on red 12 % over `--strip` 4.99:1; `--green` on green-solid 14 % 6.37:1;
  `--magenta` on magenta 14 % 5.07:1; `--amber-ink` on amber-solid 14 % 5.47:1; `--ink3` on `--strip-hi` 4.76:1; `--ink3` dot on `--steel` 4.55:1;
  `--on-accent` on `--ink` 18.58:1. Every word the spec sets on a tint passes.
- spec:179 — the eleven rows counted: Status, Assignee, Reporter, Priority, Sprint, Parent, Labels, Created · updated, On boards, Repository, Session
  (`JiraDetail.tsx:345-377`). Correct.
- spec:111-112 — the ARIA-name claim holds: the row's `title` is the label and the sub-line/mark are `aria-hidden`, so `getByRole('button', { name:
  /Groom ticket/ })` resolves to the label; `test/jira-board.test.tsx:756` `/^Run PAY-/` also still matches only the left half (`Run options for` does not
  start with `Run PAY-`).
