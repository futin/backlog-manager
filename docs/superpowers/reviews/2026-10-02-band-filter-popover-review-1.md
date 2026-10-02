# Review 1 — `docs/superpowers/plans/2026-10-02-band-filter-popover.md`

Date: 2026-10-02. Reviewer: a fresh Fable session, handed only the plan path, the spec path and the checklist. Every claim below was checked against the
code named; `<doc>:<line>` is the plan, `<spec>:<line>` the spec at `docs/superpowers/specs/2026-10-01-band-filter-popover-design.md`, every other
`file:line` is the repo at `e14c5fe` (one commit past the `fdc1fb1` the plan's line numbers cite — only the plan file differs, so every cited range was
checked and holds; the ones that drift by a line or two are noted inline and none is wrong enough to mislead).

## Verdict: REVISE

One Critical: the plan hands `Popover` its width as an inline style, and an inline `width` outranks the `width: auto` the plan's own `.ui-popover-narrow`
rule carries — so on a phone the tracker's panel is 420 px in a 351 px rail bar and the band's two are 300 px under a wrapped button, while every test the
plan writes for the phone shape stays green (the class is present; the source check reads the rule, not the cascade). Five Important findings, each a
place an implementer must guess or a stated fact is false: two `orchestrator-start-ui` lines that are not `selectOptions` calls and vanish with the
`<select>`, a ninth narrow declaration the plan adds silently while telling the reader the spec wins on disagreement, a spec test case (the Board's
`Orchestrate needs one` hint) with no task, the wrong React major, and a `Status` section whose markup and classes have no named home.

Coverage otherwise is complete: every §4 case and every §5 doc edit maps to a task (the map is at the end), every Produces/Consumes pair matches by name
and type, no task depends on a later one, each task's first step fails for the reason the plan gives, the five Review Focus items each have a case in
Task 4, every copy string and size matches the spec verbatim, and the plan keeps its own "behaviour, never code" rule throughout.

## Critical

### C1 — `<doc>:74-75` (Task 1 Interfaces), with `<doc>:98-99` and `<doc>:128`: an inline `width` beats `.ui-popover-narrow { width: auto }`, so the phone shape never takes effect

The plan: `Popover` renders its panel "with the width applied inline as the un-capped value (the CSS caps it)", and the phone modifier `.ui-popover-narrow`
carries `… width: auto; max-width: none …`. The tracker renders through it `at width={420}` (`<doc>:128`), the band's two at `width={300}` (`<doc>:180`).

- An inline `style="width: 420px"` is a style-attribute declaration; every class-selector rule in the sheet — `.ui-popover-narrow { width: auto }`
  included — loses to it in the cascade (only `!important` would win). The modifier's `width: auto` is dead the moment the width is inline.
- The plan then also sets `max-width: none` on the modifier, which removes the one cap the base rule has. Net result below 700 px: `position: fixed;
  left: 12px; right: 12px; width: 420px` — over-constrained, so `right` is ignored and the panel runs from 12 px to 432 px on a 375 px phone. Same for the
  band's 300 px panels on a wrapped band.
- Today it works only because the width is in CSS: `client/src/styles.css:338-339` sets `width: 420px` on `.tracker-pop` and the 700 px override at `:363`
  sets `width: auto`, both class rules, so the later one wins. The dashboard the plan copies from does the same — `../claude-agents-dashboard/client/src/
  styles.css:683` (`width: min(300px, calc(100vw - 48px))`) and `:1043` (`.pop{width:300px}` in its narrow block).
- None of Task 1's cases catches it. `<doc>:85-86` asserts the dialog carries class `ui-popover-narrow` (it will); `<doc>:87-88` asserts the rule's text
  contains `width: auto` (it will). jsdom does no cascade. Task 6's phone check at `<doc>:289` ("the panels are full width under their button") is the first
  thing that would see it — after four commits.

**Fix:** keep the width out of the `width` property. Either hand it over as a custom property (`style={{ '--ui-popover-width': `${width}px` }}` with
`.ui-popover { width: var(--ui-popover-width) }` in the base rule, so the modifier's `width: auto` wins as a later class rule), or render the inline style
only while `useNarrow()` is false. Then add one case to `test/ui-popover.test.tsx`: under the narrow stub the dialog's `style.width` is empty (or, with the
property route, the base rule's `width` reads the property — a source check beside the existing one). Task 2's visible-change list at `<doc>:135-136` is
unaffected either way.

## Important

### I1 — `<doc>:204` with `<doc>:213-215`: two lines in `orchestrator-start-ui.test.tsx` that are not `selectOptions` calls go away with the `<select>`, and the plan names no replacement

The migration rule at `<doc>:213-214` is "every `userEvent.selectOptions(getByLabelText('Project' | 'Status' | 'Sort'), …)` … becomes the matching helper",
and `<doc>:204` scopes this suite's change to "~201-210 only". Inside that range:

- `test/orchestrator-start-ui.test.tsx:202` — `await waitFor(() => expect(screen.getByRole('option', { name: 'alpha' })).toBeInTheDocument())`. There is no
  `<option>` after Task 4; the wait never resolves and `renderNarrowed()` — called by at least eleven cases in that file (`:229`, `:245`, `:300`, `:313`,
  `:329`, `:388`, `:424`, …) — times out in every one of them.
- `test/orchestrator-start-ui.test.tsx:210` — `await waitFor(() => expect(screen.getByLabelText('Project')).toBeInTheDocument())`. After Task 4 the only
  element labelled `Project` is `ProjectPicks`' `role="group"`, which exists only while the `Filters` popover is open; with it closed the query throws.

Neither is a `selectOptions` call, so the rule as written skips both, and the implementer meets them as red cases with no instruction.

**Fix:** state the replacements in Task 4 Step 1: `:202` waits on the fetched project the way the helper does (a `findByRole('button', { name: 'alpha' })`
inside the opened dialog — or simply `await pickProject('alpha')`, whose `findByRole` is the wait); `:210` waits on the `Filters` button, the band's
always-present control. The same rule catches `test/board.test.tsx:281-285` (the band case's `getByLabelText(name)` loop), which the plan does replace
outright at `<doc>:218-219` — say so, since it is the only other non-`selectOptions` reader.

### I2 — `<doc>:98-99` against `<spec>:38-44`: the plan's `.ui-popover-narrow` has nine declarations, the spec says "these eight", and the plan's own preamble says the spec wins

`<spec>:43-44`: "`Popover` reads `useNarrow()` and adds `ui-popover-narrow`, declared once in the primitives block with these eight declarations", listing
`position: fixed; top: auto; margin-top: 8px; left: 12px; right: 12px; width: auto; max-height: 70vh; overflow-y: auto`. The plan adds `max-width: none`
without comment. `<doc>:8-9` tells the implementer "where the plan and your reading of the code disagree, the spec and the code win".

The ninth declaration is right and the spec's count is wrong: the base rule the spec itself specifies (`<spec>:36-37`, `<doc>:97-98`) caps `max-width` at
`calc((100vw - 48px) / var(--font-scale, 1))`, and under `left: 12px; right: 12px; width: auto` that cap over-constrains the box — `right` is dropped, the
panel ends 36 px from the right edge against a 12 px left inset. Today's `.tracker-pop` needs no `max-width: none` only because its base rule has no
`max-width` (`client/src/styles.css:338-342`). So a reader who obeys the preamble and trims to eight ships a lopsided phone panel; a reader who keeps nine has
to decide the preamble does not mean what it says.

**Fix:** keep `max-width: none` and add one clause at `<doc>:99`: a deliberate ninth over the spec's eight, because the base rule's viewport cap would
otherwise over-constrain the inset box. (With C1's custom-property route the base `width` also needs nothing further; with the conditional-inline route it
does not either.)

### I3 — `<doc>:217-235` against `<spec>:173`: the Board half of "Archive's Project section carries no hint; the Board's carries `· one at a time — Orchestrate needs one`" has no case

Task 5 Step 1 (`<doc>:273-274`) asserts the Archive half — "no `Orchestrate needs one` anywhere in the dialog". Task 3's `ProjectPicks` case (`<doc>:174-175`)
asserts the prop renders when given, which pins the component, not that `BoardView` passes it. No case in Task 4's list opens the Board's `Filters` dialog and
looks for the hint. `BoardView.tsx:689-699` carries no hint today, so the test would fail before the implementation, which is what the checklist asks for.

**Fix:** one line in Task 4's band case or Review Focus 4 case (`<doc>:234`): the open `Filters` dialog contains the text `· one at a time — Orchestrate needs
one`.

### I4 — `<doc>:19`: "React 19 + Vite client" is false — the client is React 18

`package.json:34-35` — `"react": "^18.3.1"`, `"react-dom": "^18.3.1"`; there is no `client/package.json`. The number is load-bearing for this plan in one
place: `Popover`'s `anchor: RefObject<HTMLElement | null>` (`<doc>:73`). Under React 18's types `useRef<HTMLButtonElement>(null)` is `RefObject<HTMLButtonElement>`
whose `current` is already `T | null`, and the `| null` in the plan's parameter is harmless; under React 19's it would be `RefObject<HTMLButtonElement | null>`
and an implementer reaching for 19-only shapes (`ref` as a plain prop on a function component, `use`) gets a typecheck failure in Task 6 with no plan line
to point at.

**Fix:** `React 18 + Vite client`.

### I5 — `<doc>:186-191` with `<doc>:246-247`: the `Status` section's markup lives in `BoardView` but its classes are only ever named in `FilterBar`'s CSS, and no element is specified

Task 3 Step 3 styles "section headings 12 px `--ink2`, hint `--ink3`" and the full-width switch through `.filter-bar-switch > [role="group"]` and
`.filter-bar-switch button` (`<doc>:186-187`, `:190-191`). Task 4 Step 3 says the Board's children are "`ProjectPicks` with the Board hint, then the `Status`
heading and its `Segmented pill` switch" (`<doc>:246-247`). `ProjectPicks` has one home for the `Project` heading and its hint (`<doc>:158-160`). The
`Status` heading and the `.filter-bar-switch` wrapper have none: the plan never says which element `BoardView` renders for the heading, which class it
carries, or that `BoardView` is expected to write `className="filter-bar-switch"` on a wrapper of its own — a page using another component's class
family, which the spec calls `FilterBar`'s own (`<spec>:58-59`). The implementer guesses the heading's element and class, and the two headings (Project's in
`ProjectPicks`, Status's in `BoardView`) can drift.

**Fix:** either name the markup in Task 4 Step 3 (the heading element and the `.filter-bar-*` class it and the switch wrapper carry), or have Task 3 export
one small section wrapper from `FilterBar.tsx` — heading, optional hint, children — that `ProjectPicks` renders through as well, so both headings and the
switch wrapper have the one home the spec's one-home rule asks for.

## Minor

- `<doc>:87-89` — "read `client/src/styles.css` the way `test/tracker-chip.test.tsx`'s phone guard does". That guard (`test/tracker-chip.test.tsx:147-149`)
  first slices the `@media (max-width: 700px)` bodies out and regexes inside them; `.ui-popover-narrow` is in the primitives block, not a media block, so a
  literal copy finds nothing. Say "regex the rule out of the whole sheet", or use `ruleBlock` from `test/helpers/css-rule.ts:25` which already does it with a
  boundary check.
- `<doc>:188-189` with `<doc>:209-210` — each sort option row is a `button` whose content includes the 11 px hint, so its accessible name is
  `Created when it was filed`, not `Created`; `pickSort('Created')` with Testing Library's default exact match misses it. State the row's name (an
  `aria-label` of the bare label, or the helper matching `^Created`), so the helper and the Task 3 `aria-pressed` lookup agree.
- `<doc>:279` — "`grep -rn "board-filter" client/ test/` must come back empty" cannot be true before Task 6: `client/dist/` is gitignored build output and
  three bundled files in it carry the string today (`client/dist/assets/BoardView-*.js`, `ArchiveView-*.js`, `index-*.css`). Scope it to `client/src/ test/`.
- `<doc>:199` / `:250-252` — Task 4's comment list omits `BoardView.tsx:280-282` (the fail-open comment: "the fallback feeds back into the select"), while
  Task 5 lists Archive's twin (`ArchiveView.tsx:149-151`, cited there as ~147-149). Add it, or the Board keeps one comment naming a control that is gone.
- `<spec>:165` "Clear all is inert at count 0" sits under the Board heading; the plan covers it only as the `FilterBar` unit case (`<doc>:166`). That is
  adequate — the inertness is `FilterBar`'s — but worth one word in Task 4 so the next coverage pass does not file it as a gap.
- `<doc>:209-211` — the helpers leave the popover open after a pick ("none closes it"). In `orchestrator-start-ui.test.tsx:394-444` and
  `tracker-board.test.tsx:471-476` the step after `renderNarrowed()` / the pick is always a `userEvent.click` outside the panel, whose `pointerdown` closes it
  before the `queryAllByRole('dialog')).toHaveLength(1)` and `queryByRole('dialog')).not.toBeInTheDocument()` assertions run — checked:
  `@testing-library/user-event@14.6.6` dispatches `pointerdown` with a `PointerEvent` fallback where jsdom lacks one (`dist/cjs/event/createEvent.js:72`).
  Green, but only because of that ordering; a sentence in Task 4 Step 1 saying so saves the next reader the trace.
- `<doc>:133-134` — "everywhere the non-dialog Escape entries are listed as `Confirm` and `TrackerPopover`": `docs/subsystems/board.md:109-110` lists only
  `Confirm`; the plan cites ~110 anyway, so the edit is covered — just not by that sentence's description.
- `<doc>:111` cites `TrackerPopover ~143-196` and the header `~19-22`; `<doc>:113` the ref comment `~72` (it is `:71-75`); `<doc>:201` view-keys `~10-16`
  (`:12-15`); `<doc>:262` ArchiveView's project comment `~131-135` (`:132-136`); `<doc>:264` `.board-filter*` `~397-409` (`:397-409`) — all within the
  plan's own "find the text, not the number" tolerance. No action.

## Checklist record

1. **Coverage.** Spec §4 → tasks: `ui/Popover` suite (five bullets) → T1 Step 1; `FilterBar` (three) → T3; Board (thirteen) → T4, except the Board-hint
   half of `<spec>:173` (I3); Archive (two) → T5; tracker chip (two) → T2; design guards (three) → T1 (`FAMILIES`), T1/T2 Step 4 (`dialog-count-docs`,
   `claude-rules`), guard 3 unchanged and run by `design-guards` in T1/T3/T5. Spec §5 → tasks: DESIGN §8.3 → T4, §8.0 → T2, §8.5 → T5, §8.7 → T1;
   board.md table → T1, components list → T3, Escape sentences and tracker paragraph → T2, band sentence → T4; `useDialogEscape.ts` → T2; BoardView comments
   → T4 (minus the fail-open one, Minor); ArchiveView comments → T5; styles.css comments → T5; view-keys → T4; invariants "nothing else floating" → T1,
   Escape section → T2; `.claude/rules/board.md` → T2.
2. **Values.** Every copy string at `<doc>:26-28` matches `<spec>:45-51` and `:130`; count-line forms match `<spec>:114-116`; `0 items across 0 projects`
   matches `<spec>:108`; 300/420/8/20/11 match `<spec>:31-37`; the panel paint (`--strip`, `--hairline`, 12 px, `0 8px 24px var(--shadow2)`, 16 px)
   matches `<spec>:33`; the narrow rule differs by one declaration (I2); the visible tracker change list at `<doc>:135-136` matches `<spec>:86-87`.
3. **Reality.** Create targets absent: `client/src/components/ui/Popover.tsx`, `client/src/components/FilterBar.tsx`, `test/ui-popover.test.tsx`,
   `test/filter-bar.test.tsx`, `test/helpers/filter-bar.ts`. Modify targets present and the cited ranges hold (see Minor). `useDialogEscape`, `useNarrow`
   (`client/src/hooks/useNarrow.ts:24`), `Confirm` (`ui/Confirm.tsx:50` calls the hook), `Chip` `size: 32 | 28` + `pressed` (`ui/Chip.tsx:4,40`),
   `Segmented` `pill` + `label` → `role="group" aria-label` (`ui/Segmented.tsx:47`), `Dot` `hue: number` (`ui/Dot.tsx:36`), `ProjectHues.hueFor(name)`
   (`lib/project-hue.ts:100-102`), `RegistryProject` (`shared/types.ts:15`; the client's `ProjectSummary` at `:356` is a structural superset, so
   `ProjectPicks`' prop type-checks), guard 7's `FAMILIES` and its class-token check (`test/design-guards.test.ts:314-331, 375-377`), the dashboard's
   `Toolbar.tsx:85,99` SVG paths and `.ctlwrap`/`.ictl`/`.pop`/`.sw button` rules — all exist as the plan says. `test/helpers/` is outside jest's
   `testMatch` (`jest.config.ts:11`), so the helper file is not run as a suite. "React 19" is false (I4).
4. **Interfaces.** `Popover` (T1) → T2, T3; `FilterBar`, `ProjectPicks`, `SortDir` (T3) → T4, T5; the five helpers (T4) → T5. Names and types agree.
5. **Order.** T1 → T2 → T3 → T4 → T5 → T6; no forward dependency. No external prerequisite is named and none is needed.
6. **Tests.** T1/T3 fail on module-not-found; T2's narrow case fails on the missing class; T4's migrated cases fail on the missing `Filters` button; T5's on
   the missing button and suffix. Review Focus 1-5 each have a named case at `<doc>:230-235`. The phone-shape cases pass a wrong build (C1).
7. **Conventions.** No code blocks anywhere; signatures, copy and cases only. Sizes stated as soft. 160-column wrap and 72-column commit bodies restated.
