# Review 1 — Jira restyle implementation plan vs spec

Plan: `docs/superpowers/plans/2026-11-05-jira-restyle.md` · Spec: `docs/superpowers/specs/2026-11-05-jira-restyle-design.md` · Reviewer: Fable 5.1, 2026-11-05.
Every claim below was checked against the working tree at `384c96f3`; `file:line` cites are from that tree.

## Verdict: REVISE

One Critical: the plan (and the spec it carries) names a CSS selector that design guard 7 forbids, and the task that writes it claims the guard passes.
Eight Important findings, all of the "implementer must guess or a stated value is wrong" kind — none changes the design, every one is a sentence or two.

## Checklist

1. **Coverage** — every spec section maps to a task: §4.1 → T2, §4.2 → T3, §4.3 → T4, §4.4 head/Agent/Ticket → T5, §4.4 Status and Move to → T6, §5
   glyphs/divider → T1, §6 every suite named → T1–T6, §7 → T7 (and T6 for §8.7), §6's last bullet → T8 (`/ui-verify`, as CLAUDE.md requires). No spec
   test case is without a task. Mocks are cited in every task that draws a view (T2–T6). Gaps are in the *how* (findings I1, I2, I4, I5), not the *what*.
2. **Values** — copy strings match the spec except the band sub-line example (I3). Titles, menu copy, footer, tint hue/percent/surface all match.
3. **Reality** — all Create targets absent (`ui/Glyphs.tsx`, `ui/SplitChip.tsx`, `test/ui-split.test.tsx`); all Modify targets exist. Line references
   verified: `design-guards.test.ts:323` FAMILIES ✓, `lib/jira.ts:726/745/755/849` ✓, `tracker.ts:37` ✓, `Popover.tsx:39` ✓, `JiraTypeIcon.tsx:5-13`
   (paths at :14-22, close enough), `jira-board.test.tsx:761-767/:831` ✓, `jira-list.test.tsx:290/:308/:500-501` ✓, `jira-detail.test.tsx:235/421/437/446`
   ✓, `BoardColumn.tsx:63` ✓, `JiraShelves.tsx:54` ✓, `JiraDetail.tsx:237/348-353` ✓, `useDialogEscape.ts:47` ✓, `board.md:20` ✓, `invariants.md:2242`
   ✓, `dialog-count-docs.test.ts:94` ✓, DESIGN.md §8.7 "seven composers" at `:415` ✓, §8.9.1/§8.9.2 paragraph names ✓. One off-by-one (M1).
4. **Interfaces** — `SplitChip`, `Glyph`/`GlyphName`, `priorityTone`, `typeTone`, `statusTone`, `BoardColumn.tone` are produced before they are consumed
   with the same spelling. `JIRA_BUILTIN_LABELS`, `transitionOptions`, `runChipState`, `resolveJiraAction`, `skillCommand`, `pollAge`, `Chip`, `Chevron`,
   `Popover` exist with the shapes the plan assumes (`Chip` spreads rest props so `aria-haspopup`/`aria-expanded` land, `Chip.tsx:50-58`).
5. **Order** — T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8; T5 consumes T2/T3, T6 consumes T3; nothing depends on a later task.
6. **Tests** — every Step 1 fails before Step 3 (new modules, new ARIA names, new attributes). Review Focus 1–5 each have a case (RF1 T3 `P1`; RF2 T2
   stale `jiraDefaultAction`; RF3 T6 two-to-one fixture + current-status row — but see I5; RF4 T6 double click; RF5 T3 0/1/2 paths — the plan's "three"
   in RF5 vs "two paths" in the case is fine, `N repos` is the same branch). Fixtures discriminate (`High`/`Medium`/`Lowest`/`P1`/`null`;
   bug/story/task/sub-task-named-Bug/epic-named-Story). Existing-site enumeration is incomplete (I6, I7).
7. **Conventions** — behaviour and cases, no literal code ✓; soft line counts ✓; mock cited per view task ✓; `/ui-verify` last ✓.

## Critical

- **[C] plan:102, :116-117 (and spec §4.1 :109, §6 :236) — `.jira-run[data-state='live'] .ui-split` cannot exist outside the primitives block.**
  Guard 7 (`test/design-guards.test.ts:380-396`) walks EVERY `.class` token of every selector outside the block and fails any token that prefix-matches a
  `FAMILIES` entry — and Task 1 appends `'ui-split'` to that list (plan :72). The comment at `:388-391` says it exactly: "a descendant selector cannot
  smuggle one in on its right-hand side." Task 2 Step 4 (:120) then claims `test/design-guards.test.ts` PASSES, which it will not; the implementer's only
  ways out are to loosen the guard (spec §2's named anti-goal) or to put a Jira-specific rule inside the primitives block (which the spec forbids: "a
  Jira-local rule ... not a state on the primitive"). The repo's own precedent avoids the family token: `.jira-run[data-state='no-repo'] > button`
  (`client/src/styles.css:1288`). → State a guard-safe selector — `.jira-run[data-state='live'] > [role='group']` (SplitChip's root is the `role="group"`
  span, plan :62) or `.jira-run[data-state='live'] > span` — and use that same string as the `PINNED` key at :116-117. Note the deviation from spec §4.1
  in the report, per the plan's own :19 rule.

## Important

- **[I] plan:174-176 (Task 4) — no guard-safe mechanism for the toned header dot and the `--strip` count pill.** `Dot` has no `--ink3` /
  `--amber-solid` / `--green-solid` tone of its own (`client/src/components/ui/Dot.tsx:1`; `styles.css:3434-3445` — only `live/paused/crashed/done` and
  `ramp-*`, and `.ui-dot-done` is `--fill-progress`, not `--green-solid`), and a page rule `.board-col[data-tone] .ui-dot` or `... .ui-pill` fails guard 7
  (same mechanism as the Critical). `BoardColumn` renders `<Dot />` and `<Pill tone="neutral">` inside `.board-col-pill` (`BoardColumn.tsx:79-92`). →
  Say how: with `tone` set, `BoardColumn` draws a page-local `.board-col-dot[data-tone]` span in place of `Dot` and a page-local `.board-col-count` span
  in place of `Pill` (the spec's "count pill" is a look, and it says "not a new `Pill` tone"), both styled under `.board-col[data-tone]`; or declare three
  new `DotTone` members inside the block and have the count stay a `Pill` on `--strip-hi` (a spec deviation to report). Either way name it so guard 7
  stays green and the test asserts `data-tone` on the root as written.

- **[I] plan:196-199, :203-204 (Task 5) — the facts `dt` glyph has no route, and the wrong one breaks all eleven assertions.** The dl is built from
  `Fact` (`client/src/components/ui/Fact.tsx:15-18`), whose `label: string` is the dt's whole content and which the item modal shares; the plan lists no
  change to `Fact` and no replacement. The suite's `fact(label)` helper (`test/jira-detail.test.tsx:194-200`) finds the DT by `queryAllByText`, which
  matches an element's DIRECT text nodes only — a `<span>` around the word leaves the DT unmatched and every `fact('…')` returns `null`. → Add
  `client/src/components/ui/Fact.tsx` to Task 5's files; give it `icon?: ReactNode` drawn before the label text with the word left as a direct text node
  of the `dt`; say so in Step 1 ("the eleven `dt` words stay direct text of the `dt`, the glyph is an `aria-hidden` sibling").

- **[I] plan:201 (Task 5) — `default: Work the ticket` is not any action's label.** The execute action's label is `Work it end to end`
  (`shared/types.ts:818-821`); `Work the ticket end to end` is the Run menu's SUB-LINE for that row (plan :95, spec :133). The band sub-line is
  `default: <default action's label>` (plan :194, spec :165), so for the execute default it reads `default: Work it end to end`, for the skill fixture
  `default: Groom ticket`. → Replace the example with the exact strings and assert them (two cases, one built-in and one skill, so a sub-line-vs-label
  swap fails).

- **[I] plan:194, :201-202 (Task 5) — `last run <age>` names no source.** The spec (§4.4 :165) leaves it open; the plan must close it. `JiraDetail`
  already derives the `ended` links (`JiraDetail.tsx:304-311` draws `History` from them). → State: the newest ended link's `endedAt`, printed by
  `pollAge(endedAt, now)` (the same words the history line uses), omitted when `ended` is empty; give the fixture (`endedAt: hoursAgo(1)`) and the exact
  expected text in Step 1.

- **[I] plan:226-229 (Task 6) — the "current-status row is first" case has no fixture, and the existing one is ambiguous under the rule.** The suite's
  `TRANSITIONS` (`test/jira-detail.test.tsx:170-172`: `In Progress`, `Done`) lands nothing on the current status `In Review`; the only fixture that does
  (`:867-874`) lands TWO transitions on `In Review` — `In Review` and `In Review (2)` — behind `In Testing`. The plan's rule "the row whose `to.name`
  equals the current status ... drawn FIRST" (singular) does not say what that fixture renders: both rows first and both `aria-disabled`, or one; and
  whether `In Testing` then follows. → Give both fixtures and their exact row order: (a) a new three-transition fixture with one landing on `In Review`
  → `[In Review (aria-disabled, tick), In Progress, Done]`; (b) the `:867` fixture → `[In Review, In Review (2)]` both `aria-disabled`, then
  `In Testing` — or whatever the spec intends ("every row landing on the current status is pinned first, in Jira's order" is the reading that keeps the
  `transitionOptions` labels and Review Focus 3 together).

- **[I] plan:106-113 (Task 2) — the existing sites that click the LEFT half and then expect `Run menu` are enumerated for `jira-list` but not for the
  other two suites.** `jira-board.test.tsx`: `runChip()` is `/^Run PAY-/` (`:756`), the left half, and `:826`, `:838`, `:849`, `:862`, `:931` click it and
  then read `Run menu`. `jira-detail.test.tsx`: `modalRun()` is `Run PAY-131` (`:472`) and `:550-551`, `:555-556`, `:568-569`, `:1061-1062` do the same;
  `:589-590` (no-repo click opens nothing) stands. Also `:571` pins `--ui-popover-width` at `234px` (the plan sets 300 px in every home, :94) and
  `:572-573` pin the modal's `scrollIntoView` on open (`JiraRunMenu.tsx:71-74`), which the plan neither keeps nor drops. → List those sites as moving to
  `Run options for <key>`, change `:571` to `300px`, and say whether the modal's `scrollIntoView` stays (recommended: stays — the band is at the top of a
  column that can still scroll under 700 px) so the pin is updated on purpose, not by whoever sees it go red.

- **[I] plan:201-204 (Task 5) — three existing `jira-detail` cases contradict the band and are not named.** `:808-814` ("draws Run ▾ after the cards and
  the history — last in the agent column") asserts `column.lastElementChild` contains `Run PAY-131` and that `.jira-hist-list` PRECEDES it; the band puts
  the Run first and `History` under the band (plan :196). `:548` asserts `.jira-modal-controls` contains the Run (the plan removes `jira-detail-run`
  from it). `:748` asserts the sentence `no session is running on this ticket`, which becomes `No session on this ticket`. → Say each inverts or moves:
  the Run is inside `.jira-detail-agent-band`, which precedes `.jira-hist-list`; `.jira-modal-controls` no longer contains it; the old sentence is gone.

- **[I] plan:101 (Task 2) — the live state's ` · <age>` names no source either.** Spec §5 leaves "the exact `pollAge` source" to the builder; the plan
  repeats "when known" without choosing. `JiraRunMenu` already reads `sessions` (`JiraRunMenu.tsx:66`) and `runChipState` finds the live `run` link
  (`lib/jira.ts:733`); the shell's `status.live[key]` is the other source and carries no start stamp. → State: `pollAge` of the newest live link's
  `startedAt` among `sessions.links` for the key; omitted when the live reading comes from `status.live` alone (sessions not landed). Add the case to
  the `jira-detail` live assertion (`text starts Running`, and `Running · 2h` with a link started `hoursAgo(2)`).

## Minor

- plan:84 — `MODAL_PANEL_WIDTH` is declared at `JiraRunMenu.tsx:62`, not `:61` (`:61` is the end of its comment).
- plan:34 — the commit trailer names `Claude Opus 5.5`; the executing session's own attribution reminder governs the trailer, so say "the session's
  attribution line" rather than a model name.
- plan:116-117 — the `PINNED` key must equal the CSS selector after whitespace normalisation only (`tintSites()`, `test/daylight-contrast.test.ts:136-150`);
  the plan writes `data-state="live"` here and `data-state='live'` at :102, and `styles.css` uses single quotes (`:1288`). Pick one. (Moot once the
  Critical is fixed, but the same applies to whatever selector replaces it.)
- plan:243 — "spec §7's five bullets" into §8.9.1/§8.9.2: the fifth (§8.7 seven → eight) is Task 6's edit (:233-234); say "four bullets" or cross-reference.
- plan:222 — "First enabled row takes focus on open" has no case in Step 1 (:226-231); add one (and the Escape-returns-focus-to-the-chip case the
  `Popover` already gives, `Popover.tsx:63-66`).
- plan:84 — `.jira-run[data-state='no-repo'] > button { border-style: dashed }` (`styles.css:1288`) is superseded by the `dashed` prop and
  `.jira-modal-controls .jira-run { position: static }` (`:1293`) loses its reason with the band; name both as going so neither is left to restyle a
  button that no longer exists.
- plan:196 — `Next session takes over once this one ends.` (`JiraDetail.tsx:316`, drawn beside the Run while live) is not placed; say it stays beside the
  Run on the band's label row.
- plan:88 — "`JiraRunMenu.tsx:65` reads it the same way": that line reads `data` and hands it to `runChipState`; the `status.repos[project.key]` read is
  `lib/jira.ts:731`. `JiraCard` should call `runChipState`-style logic or read `data.repos` directly — either is fine, just cite the right line.
- spec §6 :237 says `jira-list` has "three sites that expect `Run menu`"; the plan (:114-115) is right that there are two (`:308`, `:500-501`) and `:290`
  only asserts presence. Worth a one-word spec correction when the plan's deviations are reported.
- plan:149 — `priorityTone('')` → `other`: consistent with "any other string → `other`" (:132), but `JiraDetail.tsx:364` treats `''` as absent for the
  `Priority` fact; say the card does the same (`''` draws no pill, like `null`) or that it draws the grey pill with an empty word — the test should pin
  one.
- plan:57 — `size?: 14 | 16 | 10`: order as `10 | 14 | 16`. Taste.
