# Review 1 re-check — Jira restyle implementation plan, revision after review 1

Plan: `docs/superpowers/plans/2026-11-05-jira-restyle.md` · Spec: `docs/superpowers/specs/2026-11-05-jira-restyle-design.md` · Previous round:
`docs/superpowers/reviews/2026-11-05-jira-restyle-review-1.md` · Reviewer: Fable 5.1, 2026-11-05. Scope: only the hunks in the revision diff; every
`file:line` below was read in the working tree at `9c197085`.

## Verdict: APPROVE WITH FIXES

The Critical from round 1 is closed correctly: `.jira-run[data-state='live'] > [role='group']` carries no `ui-*` class token, so guard 7
(`test/design-guards.test.ts:380-396`, tokens via `/\.[\w-]+/g` against `FAMILIES` at `:323`) stays green, and the `PINNED` key rule ("whitespace
normalisation, quotes included") matches `tintSites()` (`test/daylight-contrast.test.ts:142` — `.trim().replace(/\s+/g, ' ')`, quotes untouched). All eight
round-1 Important findings were addressed, and every new cite was verified (list below). Three new facts in the revision are wrong — all three are test
values an implementer would transcribe — so the plan needs one more pass on Task 6 Step 1 and Task 2's live-age rule.

## Round-1 findings — closure check

| Round 1 | Plan line now | Closed? |
| --- | --- | --- |
| C — `.ui-split` selector fails guard 7 | :103-105, :124-125 | Yes — guard-safe selector, deviation from spec §4.1 named, same string as the `PINNED` key. |
| I1 — toned dot / count pill mechanism | :183-186, :188-189 | Yes — page-local `.board-col-dot` / `.board-col-count` under `.board-col[data-tone]`; test cases added. See M2. |
| I2 — facts `dt` glyph route | :197, :210-212 | Yes — `Fact` gains `icon?: ReactNode` (`Fact.tsx:1` already imports `ReactNode`), word stays a direct text node, matches `fact()` at `test/jira-detail.test.tsx:194-200`. |
| I3 — `default: Work the ticket` | :216-218 | Yes — `default: Work it end to end` is `JIRA_BUILTIN_LABELS.execute` (`shared/types.ts:819`); `Groom ticket` is the fixture at `test/jira-detail.test.tsx:545`. |
| I4 — `last run <age>` source | :206-208, :218-219 | Yes — `ended` is newest-first by `endedAt` (`lib/jira-sessions.ts:167-170`, drawn at `JiraDetail.tsx:304-311`); `pollAge(hoursAgo(1))` → `elapsedSince` → `1h` (`lib/item-age.ts:65-80`). |
| I5 — current-status pinning fixtures | :240-241, :249-251 | Partly — rule stated (both landing rows pinned, Jira's order) and two fixtures given, but the row labels in both are wrong (I1, I2 below). |
| I6 — jira-board / jira-detail `Run menu` sites | :115-116, :119-121 | Yes — `:756` is `/^Run PAY-/`; `:826/:838/:849/:862/:931` and `:550/:555/:568/:1061` all click the left half and read `Run menu`; `:570` pins `234px`; `:572-573` pin `scrollIntoView({ block: 'nearest' })` (`JiraRunMenu.tsx:71-74`); `:589-590` stands. |
| I7 — three inverting `jira-detail` cases | :219-221 | Yes — `:548` (`.jira-modal-controls` contains the Run), `:748` (`no session is running on this ticket`), `:808-814` (`lastElementChild` + `.jira-hist-list` precedes). |
| I8 — live ` · <age>` source | :101-102, :118-119 | Chosen, but on a false premise — see I3 below. |
| M1–M11 | :84, :33-34, :124-125, :265, :251, :106-107, :209, :144, :157 | All applied. `MODAL_PANEL_WIDTH` is at `JiraRunMenu.tsx:62` ✓; `:1288` / `:1293` ✓; `JiraDetail.tsx:316` / `:301` / `:364` ✓; `lib/jira.ts:731` ✓; §7 has five bullets, the fifth §8.7 ✓. |

## Checklist (changed lines only)

1. **Values** — band copy, built-in label, footer, titles, tint hue/percent/surface all match the spec. The Move-to row labels in Task 6 Step 1 do not
   match what `transitionOptions` produces (I1, I2). The live-age rule omits an age the spec says to print when known (I3).
2. **Reality** — every new cite read and confirmed (table above), plus `design-guards.test.ts:380-396`, `styles.css:1288/:1293`, `JiraRunMenu.tsx:62/:71-74`,
   `BoardColumn.tsx:79-92` (the file is `client/src/components/board/BoardColumn.tsx`), `Popover.tsx:63-66` (Escape returns focus to the anchor). One
   false fact: `status.live[key]` DOES carry a start stamp (I3).
3. **Interfaces** — `Fact.icon`, `.board-col-dot` / `.board-col-count`, `[role='group']` (SplitChip's root, plan :62) are produced where consumed.
4. **Tests** — the new cases fail before implementation. Task 6 (a) and (b) as written would fail AFTER implementation too, because the expected labels
   are not the labels the rule the plan itself names (`transitionOptions`) yields (I1, I2).
5. **Conventions** — behaviour and cases, no literal code ✓.
6. **Contradictions** — none with untouched plan text; none with guard 7 or `PINNED`. One transient-order ambiguity (M1).

## Important

- **[I] plan:249-251 (Task 6, fixture (a)) — the expected row labels are the transitions' names, but `transitionOptions` labels a row by its LANDING
  status whenever that status is unique.** `client/src/lib/jira.ts:849-853`: `label: landings > 1 ? t.name : t.to.name`. In `[Start → In Progress,
  Back to review → In Review, Done → Done]` every landing is unique, so the rows read `In Progress`, `In Review`, `Done` — never `Start` or `Back to
  review`. The plan's "(in (a), `Start`)" for the first enabled row is wrong for the same reason. → Rows `[In Review (aria-disabled), In Progress, Done]`;
  first enabled row `In Progress`. (If the author wants the transition's own name visible, the fixture needs a second transition landing on the same
  status, as (b) has.)

- **[I] plan:251 (Task 6, fixture (b)) — `In testing` is the transition's name; the row shows `In Testing`.** Fixture `test/jira-detail.test.tsx:870`:
  `{ name: 'In testing', to: { name: 'In Testing' } }` lands alone, so its label is `to.name` = `In Testing` — exactly what the existing assertion at `:879`
  already pins for the select. → `[In Review, In Review (2)]` both `aria-disabled`, then `In Testing`.

- **[I] plan:101-102 (Task 2) — "omitted when the live reading comes from `status.live` alone" rests on a false fact and contradicts spec §4.1.**
  `JiraLiveSession` carries `startedAt: string` ("ISO instant the key was reserved", `shared/types.ts:919-924`), and the suite's `SESSION()` fixture sets it
  three hours back (`test/jira-detail.test.tsx:468-470`). The spec (`:93-94`) says ` · <age>` is printed "when the age is known (`pollAge` of the newest
  live session's start)" — on the `status.live` path it IS known, so omitting it ships less than the spec asks, and round 1's "carries no start stamp" (the
  sentence the plan transcribed) was wrong. → Rule: `pollAge` of `status.live[key].startedAt` when that entry exists, else of the newest open `how === 'run'`
  link in `sessions.links` (the predicate `runChipState` uses, `lib/jira.ts:734`); the existing live case at `:580` (`status: { live: SESSION() }`) then
  reads `Running · 3h`, and the planned `hoursAgo(2)` link case stays `Running · 2h`.

## Minor

- **M1 plan:107** — "`.jira-modal-controls .jira-run { position: static }` (`:1293`) goes with the modal controls row (Task 5)". Read literally it goes in
  Task 5; a reader of the Task 2 files list may delete it in Task 2, when the Run still sits in the 290 px facts column with a 300 px popover (`:94`) —
  the cut-off the comment at `styles.css:1289-1291` describes, for the three commits between. Say "in Task 5, not here".
- **M2 plan:184-185, :188-189** — `.board-col-count` replaces the `Pill`, but the wrapper `.board-col-pill[data-testid="col-count"]` (`BoardColumn.tsx:88`)
  must stay around it: five `jira-board` assertions read `getAllByTestId('col-count')` for the count (`test/jira-board.test.tsx:323, :332, :586, :683,
  :1190`). Say the span is drawn INSIDE that wrapper.
- **M3 plan:101** — "the newest live link" should name the predicate: `how === 'run' && endedAt === null` (`lib/jira.ts:734`), so an open `branch` link
  (fixture `test/jira-detail.test.tsx:697-698` has one 2 h old beside a 1 h `run` link) does not supply the age. Moot if I3 is taken as written.
- **M4 plan:116** — the five `jira-board` sites are cited by a mix of click line and read line (`:826` is the click, `:849` and `:862` the read, `:931` the
  click). Harmless; the implementer finds them by `runChip(` + `Run menu` either way.
- **M5 plan:218** — `endedAt: hoursAgo(1)` on a link whose `startedAt` defaults to three hours ago (`:492`) is a consistent fixture; note the existing case
  at `:798` already has exactly that link, so the new assertion can live there.

## Autopilot

No decision or parked question was needed: the brief fixes the checklist and severity scale, and nothing in the diff left a choice to make.
