# Review 2 — `docs/superpowers/plans/2026-10-02-band-filter-popover.md` (re-check of the review-1 revision)

Date: 2026-10-02. Reviewer: a fresh Fable session, handed the plan path, the spec path, the checklist and the revision as a git diff. Scope: only the lines
the diff changes, read with their surrounding context. `<doc>:<line>` is the plan as revised (the `b9d9ea6` blob at `4f4bd23`), `<spec>:<line>` is
`docs/superpowers/specs/2026-10-01-band-filter-popover-design.md`, every other `file:line` is the repo at `4f4bd23`. Every claim the revision makes about
the code was checked against the code, not against review 1's description of it.

## Verdict: APPROVE

No Critical, no Important. The revision answers review 1's one Critical and all five Important findings, and three of its Minors, without introducing a
false statement, a spec contradiction, a forward dependency or a test that would pass on a wrong build. Each changed claim and the evidence for it is
recorded under "What was checked"; the five Minor notes below are wording and one small test-pinning gap, none of which blocks.

## Minor

- `<doc>:235` — "in those two suites the next step is always a click outside the panel". The sentence names only `orchestrator-start-ui.test.tsx`; the
  second suite the claim covers is `tracker-board.test.tsx`, whose one dialog assertion after a pick (`test/tracker-board.test.tsx:471-476`: pick, find the
  Orchestrate chip, click it, `queryByRole('dialog')).not.toBeInTheDocument()`) holds by the same ordering. Its other bare dialog lookups (`:236-249`,
  `:405`) follow no pick at all. Name the second suite so a reader does not have to grep `ByRole('dialog')` across the four to find it.
- `<doc>:76` — "jsdom has no cascade" is the wrong reason for the right conclusion. jsdom's `getComputedStyle` does apply rules from stylesheets the
  document has loaded; what makes every jsdom test green is that no suite loads `styles.css` into the document at all (the source checks read the file
  as text — `test/helpers/css-rule.ts:5-9`). Say "the sheet is never loaded into jsdom", or a future reader who tries `getComputedStyle` to pin the
  width will be surprised in the other direction.
- `<doc>:91-94` — `ruleBlock` returns the FIRST block whose selector list mentions the selector (`test/helpers/css-rule.ts:25-28`; its own docblock at
  `:31-39` names the trap), and its scan does not skip comments (`:42-46` is a bare `indexOf`). Task 1 Step 3 asks for a long comment on the narrow rule
  (`<doc>:106-109`); if that comment names `.ui-popover-narrow` with a space after it ANYWHERE above the `.ui-popover` base rule, the lookup slices the
  base rule's body and the `position: fixed` check fails for a reason unrelated to the CSS. Either say "assert over `ruleBlocks(...)` with `some`", or
  note that the narrow rule's comment sits between the two rules, below the base one.
- `<doc>:170-172` with `<doc>:167-169` — the Project picks are "inside a `role="group"` named `Project`", and the heading now has one home in
  `FilterSection`. With the Board's hint rendered after the heading, an `aria-labelledby` pointing at the heading element would name the group
  `Project · one at a time — Orchestrate needs one`, not `Project`. Task 3's `ProjectPicks` hint case (`<doc>:188-189`) asserts only that the hint renders;
  Task 5 (`<doc>:297-298`) pins the group name on Archive, where there is no hint. One clause in the Task 3 hint case — the group is still named exactly
  `Project` with a hint given — closes it. Self-correcting in practice (`pickProject`'s lookups would fail on the Board), but cheaper to pin than to debug.
- `<doc>:106-109` against `<spec>:43-44` — the plan now says, with the right reason, that the narrow rule has nine declarations where the spec says
  "these eight"; `<spec>:151-152`'s "five declarations" source check is likewise now six in the plan. That resolves review 1's I2 for the implementer, but
  the preamble (`<doc>:8-9`, "the spec and the code win") and the spec still disagree on paper. A one-word amendment to the spec's count would remove the
  standing contradiction; the author's call, not the implementer's.

## What was checked

Every changed hunk, in diff order, with the evidence.

- **`<doc>:19` React 18 (`^18.3.1`).** `package.json:34-35` — `"react": "^18.3.1"`, `"react-dom": "^18.3.1"`; installed `react@18.3.1`,
  `@types/react@18.3.31`. True. (Review 1 I4.)
- **`<doc>:73` `anchor: RefObject<HTMLElement>`.** `node_modules/@types/react/index.d.ts:151-156` — `interface RefObject<T> { readonly current: T | null }`.
  So the `| null` is already inside the type, `useRef<HTMLButtonElement>(null)` is a `RefObject<HTMLButtonElement>`, and `readonly current` is covariant,
  so a button ref passes where `RefObject<HTMLElement>` is asked. The dropped `| null` is correct for this major.
- **`<doc>:74-77` width as `--ui-popover-width`, never inline `width`.** Review 1's C1 fix, verified end to end:
  - CSS: an inline `width` outranks any class rule; a custom property set inline is read by `.ui-popover { width: var(--ui-popover-width) }` and the
    later `.ui-popover-narrow { width: auto }` (same specificity, later in the same block, `<doc>:105-106`) wins below 700 px. Correct.
  - React 18 writes a `--`-prefixed style key through `style.setProperty` (`node_modules/react-dom/cjs/react-dom.development.js:2786`).
  - jsdom 20.0.3 ships `cssstyle@2.3.0`, whose `setProperty` special-cases custom properties
    (`node_modules/.pnpm/cssstyle@2.3.0/node_modules/cssstyle/lib/CSSStyleDeclaration.js:59-60`), so the Step 1 width case can read
    `style.getPropertyValue('--ui-popover-width')` and `style.width === ''`. The case is implementable as written.
  - "Today's `.tracker-pop` only works because its width is in CSS": `client/src/styles.css:339` (`width: 420px` in the base rule) and `:363`
    (`width: auto` in the 700 px block). True. "420 px wide in a 351 px rail bar": 375 − 2 × 12 = 351. Arithmetic holds.
- **`<doc>:89-90` the width case.** Fails before Task 1 (module not found), and it pins the one jsdom-visible consequence of the trap. Behaviour-level
  enough: the custom property IS the contract between `Popover` and the sheet.
- **`<doc>:91-95` source check via `ruleBlock`, not the phone guard's slicing.** `test/tracker-chip.test.tsx:147-148` does slice `@media (max-width:
  700px)` bodies first, and `.ui-popover-narrow` is specified in the primitives block (`<spec>:42-44`, `<doc>:36`), so a literal copy of the guard would
  find nothing — the correction is right. `ruleBlock(css, selector)` exists at `test/helpers/css-rule.ts:25` with the boundary check that keeps
  `.ui-popover` from matching `.ui-popover-narrow` (`:42-56`). The six narrow declarations and the three base ones listed match Step 3's rule text at
  `<doc>:102-106` exactly. (Review 1 Minor 1; the first-match caveat is Minor 3 above.)
- **`<doc>:103-104` `width: var(--ui-popover-width)` in the base rule; `<doc>:106-109` the deliberate ninth declaration.** `<spec>:38` lists exactly eight
  (`position`, `top`, `margin-top`, `left`, `right`, `width`, `max-height`, `overflow-y`); the plan's rule is those plus `max-width: none`. The reason given
  is CSS 2.1 §10.3.7/§10.4 as it actually behaves: `left: 12px; right: 12px; width: auto` resolves to viewport − 24, the base rule's `max-width`
  (viewport − 48, `<doc>:104-105`) is smaller, the box is re-solved over-constrained and `right` is dropped — 24 px short, flush left. Today's
  `.tracker-pop` needs no `max-width: none` because its base rule has no `max-width` (`client/src/styles.css:338-342`). Correct, and the comment
  instruction makes the implementer record it. (Review 1 I2.)
- **`<doc>:167-174` `FilterSection`, `ProjectPicks` built on it, sort-row `aria-label`.** New Produces in Task 3; Task 4's Consumes line (`<doc>:224`)
  now names `FilterSection` with the same spelling; Task 5 consumes `ProjectPicks`, which carries the section itself. `<doc>:190` adds a `FilterSection`
  case that fails on module-not-found and pins title, children, hint-only-when-given and the `fill` class. `Segmented` renders `role="group"
  aria-label={label}` with plain `button` children (`client/src/components/ui/Segmented.tsx:47-58`), so "its `[role="group"]` child" and "that group's
  buttons" at `<doc>:205-207` reach the Status switch without a family token — guard 7's token regex is `\.[\w-]+` over `FAMILIES`
  (`test/design-guards.test.ts:314-331`, `:375-377`), and `.filter-bar-section-fill` starts with none of them. The Project section is a `FilterSection`
  without `fill`, so its chips are untouched, as the line says. Sort rows named by `aria-label` of the bare label give `pickSort('Created')` an exact
  match and keep the hint visible. (Review 1 I5 and Minor 2.)
- **`<doc>:232-236` the two `orchestrator-start-ui` lines.** `test/orchestrator-start-ui.test.tsx:202` is the `waitFor` on `getByRole('option', { name:
  'alpha' })` inside `renderNarrowed()` (`:196-204`), called by eleven cases; `:210` is the `waitFor` on `getByLabelText('Project')` in test case 1. Both
  replacements are sound: the `Filters` button is in the band from first paint, and the `alpha` chip appears inside the open dialog once `/api/projects`
  lands (`FilterBar` is one stable element, `<doc>:270-271`, so the open panel re-renders with the projects). `Chip` renders a `button` unless
  `as="label"` (`client/src/components/ui/Chip.tsx:14`) and `Dot` is `aria-hidden` (`client/src/components/ui/Dot.tsx:44`), so the chip's accessible name is
  `alpha`. The ordering claim: every case asserting `queryAllByRole('dialog')).toHaveLength(1)` (`:394-404`, `:432-444`) first clicks a card tab or the
  Orchestrate button — outside the panel — and `@testing-library/user-event@^14.6.6` (`package.json:45`) dispatches `pointerdown` before `click`, wrapped
  in RTL's `act`, so the popover is unmounted before the sheet opens. The remaining `renderNarrowed()` callers (`:222-360`) go straight to
  `findByRole('button', { name: 'Orchestrate' })` and need no closed popover. In `tracker-board.test.tsx` the same holds (Minor 1). In `board.test.tsx` and
  `board-live-cards.test.tsx` nothing after a pick depends on the panel being closed: the only `getByText('alpha')` is scoped `within(card)`
  (`test/board.test.tsx:359`), and no lookup names `Open`, `Done`, `All`, `In progress`, `Created`, `Name`, `Project`, `Status` or `Filters` unscoped.
  (Review 1 I1 and Minor 6.)
- **`<doc>:242-243` the Board hint case and the count-0 inert case.** `<spec>:173` (the Board half) and `<spec>:165` ("Clear all is inert at count 0")
  now each have a Task 4 case; the hint copy matches `<spec>:46` and `<spec>:173` and the Global Constraint at `<doc>:26` byte for byte. Both fail before
  Task 4 (no `Filters` button). (Review 1 I3 and Minor 5.)
- **`<doc>:269-271` band children via `FilterSection` titled `Status` with `fill`.** Consistent with the Task 3 interface and with `<spec>:47` and `:57`.
- **`<doc>:274` the fail-open comment.** `client/src/components/board/BoardView.tsx:280-282` — "The fallback feeds back into the select, so control and
  board agree." The cited range and quote are exact. (Review 1 Minor 4.)
- **`<doc>:303` grep scope `client/src/ test/`.** `client/dist/assets/{ArchiveView-*,BoardView-*}.js` and `index-*.css` carry `board-filter` today;
  `client/src/styles.css`, `BoardView.tsx` and `ArchiveView.tsx` are the sources the task deletes it from. The narrowed scope is the one that can be
  empty. (Review 1 Minor 3.)

## Checklist record (changed lines only)

1. **Coverage.** The two spec cases review 1 found without a task (`<spec>:165`, `:173` Board half) now map to `<doc>:242-243`. No changed line removes a
   case; the `FilterSection` and width cases are additions.
2. **Values.** The hint copy, the dialog names, the nine narrow declarations and the three base ones, `300px`, `Filters`, `Clear all` — all match the spec
   or the plan's own Global Constraints; the one knowing divergence (nine vs eight) is now stated with its reason (Minor 5).
3. **Reality.** `test/helpers/css-rule.ts` + `ruleBlock` exist; `test/ui-modal.test.tsx:52-64` has the `matchMedia` stub case named; lines 202 and 210 of
   `orchestrator-start-ui.test.tsx` are what the plan says; `BoardView.tsx:280-282` is the comment quoted; React is 18.3.1 and `@types/react` 18.3.31;
   `user-event` is 14.6.6; `client/dist` is why the grep narrowed. `FilterSection`, `test/helpers/filter-bar.ts`, `ui/Popover.tsx`, `FilterBar.tsx`,
   `test/ui-popover.test.tsx` and `test/filter-bar.test.tsx` do not exist yet.
4. **Interfaces.** `FilterSection` is produced in Task 3 (`<doc>:167`) and consumed in Task 4 (`<doc>:224`) with one spelling and one signature.
5. **Order.** Unchanged: T1 → T2 → T3 → T4 → T5 → T6.
6. **Tests.** The width case, the `FilterSection` case, the hint case and the inert case each fail before their task's implementation; the width case is
   the one guard the phone shape had none of before (review 1 C1).
7. **Conventions.** No code block entered the plan; the custom-property declaration is named as a declaration, not written as code; 160-column wrap holds.
