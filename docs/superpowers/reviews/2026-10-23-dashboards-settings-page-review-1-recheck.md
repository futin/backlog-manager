# Re-check of plan review 1 — Settings › Dashboards page

Scope: the hunks of `d4769f4` in `docs/superpowers/plans/2026-10-23-dashboards-settings-page.md` (plan) and
`docs/superpowers/specs/2026-10-23-dashboards-settings-page-design.md` (spec). Every code claim below was checked against the worktree, not the document.

## Verdict: APPROVE WITH FIXES

Two Important findings, both in the plan; the rest is wording. Nothing contradicts CLAUDE.md.

## Important

- **[I] plan:128 — the `daylight-contrast` instruction would turn the guard red.** The line says the suite "pins pill tones, ~:280 and ~:403 — add
  `.ui-pill-off`'s text token there". `test/daylight-contrast.test.ts:280` is the parser guard of the *fill-site* case (`expect(sites.map(s => s.selector)).toContain(sel)`
  over rules that paint their own one-token fill — `.ui-pill-live` is there because of `background: var(--fill-live)`, `styles.css:3022`), and `:403-404` is
  the `PINNED` table of the *tint-site* case (`color-mix(...)` backgrounds — `.ui-pill-warn`/`.ui-pill-done`, `styles.css:3023,3025`). Task 2 Step 3
  (plan:140-141) gives `.ui-pill-off` a dashed border, `--ink3` ink and a strike-through — no fill and no tint — so it is neither kind of site: added at :280
  the `toContain` fails, added at :403 `actual[sel]` is `undefined` and the `toEqual` fails. Its `--ink3` text is already measured by the general text-token
  case at `:243` (`--ink3` is a token the suite already passes for `.set-dot-gray`, `styles.css:959`). → Replace with: "`test/daylight-contrast.test.ts`
  needs no entry unless the implementation paints `.ui-pill-off` with its own fill (then add it to the fill guard at ~:280) or a tint (then to `PINNED` at
  ~:403); a `--ink3` text rule is covered by the general case at ~:243."

- **[I] plan:254-255 contradicts plan:54 and spec:114 in the default-selection state.** The behaviour line says "a ↑/↓ move leaves `wanted` alone, so the
  selection follows the moved machine by id". That holds only after a row click has set `wanted`. On load `wanted` is `null` (plan:254) and
  `pickSelected(ids, null)` is `ids[0]` (plan:204, :220); the ↑/↓ controls live in the selected machine's detail head (spec:78), so pressing ↓ on the
  default-selected first machine reorders it to position 2 and the next render selects `pickSelected(newIds, null)` = the *other* machine. That is the
  opposite of edge case 3 ("Moving the selected machine keeps it selected", plan:54) and of the spec ("It follows a machine through a reorder", spec:114).
  The new Task 5 case (plan:297) clicks `Pro` first, so it cannot catch this. → Make a move set `wanted` to the moved machine's id (harmless when it is already
  that id), and add the discriminating case: "without any click, move the first machine down → it is still `aria-pressed` at position 2".

## Minor

- plan:116-117 and spec:90-91 — "the Dashboards card's `Dispatch` row" names the `view === null` fallback's row (`client/src/components/settings/DashboardsGroup.tsx:89-97`);
  the healthy card draws `AgentsStatusLines` inside Home's row through `HomeLines` (`:357`) and `DispatchSetupSteps` under it (`:250`). The
  "draws nowhere else" claim is true (grep: `DispatchStatus.tsx` and `DashboardsGroup.tsx` only) and the `the dispatch report · Shared` cases do hit the
  fallback (their stub fails the dashboards shape check, `test/settings-view.test.tsx:304-305`), so only the wording is loose. → "the Dashboards card
  (its fallback `Dispatch` row and Home's row)".
- plan:333-336 — the Task 7 list of `settings-view` edits names `:306`, `:715` and `:735-738` but not `:218`, where the Shared page case asserts
  `groupTitles()` contains `'Dashboards'`; the context line (plan:331, "Shared renders … and NOT `Dashboards`") covers it in substance. → Name `:218` too,
  so the implementer does not hunt.
- plan:336 — "(or render `settings='dashboards'` here)": the suite's harness is `renderView(scope)` (`test/settings-view.test.tsx:92`), which seeds
  `settingsScope` in localStorage; there is no `settings` prop. → "or `renderView('dashboards')` here".

## Verified as stated (no finding)

- `styles.css:957-959` holds exactly `.set-dot-green/amber/gray`; no bare `.set-dot` rule exists anywhere (`DispatchStatus.tsx:30` emits the class, nothing
  styles it).
- `test/daylight-contrast.test.ts:246-247` are the two `.set-dot-*` entries.
- `test/settings-view.test.tsx:306` is `the dispatch report · Shared`; `:735-738` is `puts the dispatch status row in the Dashboards card`; `:715-716`
  are `['Orchestrator watchdog', 'Backlog tick', 'Dashboards', 'Trackers']` / `['this server', 'this machine', 'this machine', 'this machine']`, so the
  post-task lists in the plan are the correct values with `Dashboards` and its `this machine` dropped. No `describe` titled `Claude Agents` remains (only
  comments).
- `usage.read` returns `{ usage, ageMs }` (`server/src/agents/dashboards/usage.service.ts:40`) and the offers already map it onto `usageAgeMs`
  (`offers.service.ts:66-67, :156`), matching the Task 3 note.
- `Add dashboard` is the existing accessible name queried at `test/settings-dashboards.test.tsx:203, :266, :395`; `Chip` passes `aria-*` through
  (`client/src/components/ui/Chip.tsx:50`), so an `aria-hidden` glyph is possible.
- `Dot` paints `ui-dot-<tone>` (`client/src/components/ui/Dot.tsx:42`), so `.ui-dot-crashed` / `.ui-dot-paused` are the right selectors for the new
  Task 1 Step 5 assertions, and `dispatchDotTone` is produced by Task 1 (plan:100) before Step 5 uses it.
- Edge case 3's wording change and the new Task 5 case are in the plan's own conventions (behaviour and expected values, no literal code).
