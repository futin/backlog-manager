# Review 1 — Settings › Dashboards page implementation plan

**Document:** `docs/superpowers/plans/2026-10-23-dashboards-settings-page.md` (360 lines)
**Spec:** `docs/superpowers/specs/2026-10-23-dashboards-settings-page-design.md` (241 lines)
**Reviewer:** fresh subagent, Fable 5.1, 2026-10-24. Every code claim below was checked against the worktree at `12b9ccf`.

## Verdict: APPROVE WITH FIXES

Two Important findings, both one-paragraph fixes to the plan text; the rest is Minor. Every spec section and every spec test case maps to a task (coverage
map at the end), every named path, line and export was found (Modify) or absent (Create), the produced/consumed names agree across tasks in spelling and
type, the task order is sound (Task 5 explicitly leaves `DashboardsGroup.tsx` and `SettingsView.tsx` for Task 6), and the plan keeps its own conventions
(behaviour and exact cases, no literal code; sizes soft).

## Important

### I1 — Selection does not follow a machine through a reorder (plan :253–255 vs spec :114)

Spec :114: "Selection … **It follows a machine through a reorder**". Plan :253 makes `wanted` component state with initial `null` and derives
`selected = pickSelected(ids, wanted)`; :253–255 set `wanted` only on a successful rename and a successful Add. Nothing sets it on a list-row click or on a
`↑`/`↓` move. With `wanted === null`, `pickSelected` (plan :203: "`wanted` when it is in `ids`, else `ids[0]`") answers `ids[0]` after every re-render, so:

- selecting `Pro` must set `wanted` (the plan never says the row click writes it — only that "click selects", :260);
- moving the selected first machine down one step makes the selection jump to whatever is now first, instead of following the moved machine.

No Task 5 test case (:285–298) covers a reorder, and Review Focus 3 (:54–55) lists Remove / rename / Add only.

**Fix:** state at :253 that a row click sets `wanted` to the clicked id and that a successful `↑`/`↓` write leaves `wanted` untouched (the id survives the
reorder, so `pickSelected` keeps it); add a Task 5 case "select `Pro`, move it up → `Pro` still `aria-pressed`" and add reorder to Review Focus 3.

### I2 — "The Claude Agents card on Shared" does not exist; the dispatch line's home is the Dashboards card (plan :120, :329–331; spec :91)

Plan :120 sends Task 1's behaviour assertions to "`test/settings-view.test.tsx` (the Claude Agents card on Shared)", and :329–331 tells Task 6 to move them
to "Shared's `Claude Agents` card if it still draws it — check `SharedPage`". In code:

- `AgentsStatusLines`' only callers are `HomeLines` and `DashboardsGroup` (`client/src/components/settings/DispatchStatus.tsx:3–7` header: "drawn on the Home
  row of the Dashboards card"; `DashboardsGroup.tsx:86–100` null view and `:352` `HomeLines`).
- `SharedPage` (`client/src/components/settings/SettingsView.tsx:167–190`) draws Watchdog, Tick, `DashboardsGroup`, `TrackersGroup`; `test/settings-view.test.tsx:715`
  pins Shared's groups as `['Orchestrator watchdog', 'Backlog tick', 'Dashboards', 'Trackers']` and `:735–738` asserts `rowNamesIn('Dashboards')[0] === 'Dispatch'`.
  The `Claude Agents` card (`.claude/rules/board.md`, Settings bullet: "`Claude Agents` is two cards") is Local's per-device link card; the Shared half IS the
  Dashboards card's `Dispatch` row. Its describe is `the dispatch report · Shared` at `test/settings-view.test.tsx:306`.

So Task 1 Step 5 is right about the file but names a card the implementer will not find, and Task 6's conditional has only one outcome: after
`SharedPage` drops `DashboardsGroup`, Shared draws no dispatch line at all, and every `.ui-dot-*` / setup-steps assertion must move to the Dashboards page's
Home detail (and `settings-view.test.tsx:715`, `:735–738` must drop `Dashboards`/`Dispatch`). The spec carries the same slip at :91 ("the Shared page's
`Claude Agents` card").

**Fix:** :120 → "the `Dispatch` row of the Dashboards card on Shared (`the dispatch report · Shared`, `test/settings-view.test.tsx:306`)"; :329–331 →
state flatly that Shared draws no dispatch line after this task and that those assertions move to `test/settings-dashboards.test.tsx` (Home detail), and
that `:715` and `:735–738` lose the `Dashboards` group. Spec :91 can be corrected in the same pass (one word: "the Dashboards card's Home row").

## Minor

- **M1 (plan :263) `+ Add dashboard` breaks six existing queries.** Today the chip's text is `Add dashboard` (`DashboardsGroup.tsx`), and
  `test/settings-dashboards.test.tsx:203, 266, 420, 424, 586` query `getByRole('button', { name: 'Add dashboard' })`. The `+` is the spec's (:74), but the
  plan's "adapt every existing `it`" (:283) does not say the accessible name changes. Either say so, or give the chip `aria-label="Add dashboard"` and keep the
  `+` visual — the dialog name `Add dashboard` (`:395`) is the sheet's and is unaffected either way.
- **M2 (plan :161) `usage.read` answers `ageMs`, the route field is `usageAgeMs`.** `server/src/agents/dashboards/usage.service.ts:40` returns
  `{ usage, ageMs }`; `toOffer` renames it (`offers.service.ts:66`). "Field by field" (:162) implies the rename; one clause would remove the guess.
- **M3 (plan :178–179, case 6) the URL guard never sees an `error` string.** Case 6 has every stub reachable, so `error` is absent from the body and a URL
  inside a failure message would pass. `judge`'s wording today is `${path} answered ${res.status}` (`dashboard-status.service.ts:195`) and Node's
  `fetch failed`/abort messages carry no URL, so the risk is small; still, point case 6's `Pro` at the refused origin so the `no http://` assertion covers
  the `error` field too.
- **M4 (plan :130) `test/daylight-contrast.test.ts` does pin pill tones.** It maps `.ui-pill-live` (:280) and `.ui-pill-warn`/`.ui-pill-done` (:403–404)
  to their ink tokens. Task 2's `off` look on `--ink3` (:138) is a new class, not a change to those, so no entry is needed unless the guard also walks
  compound rules — the "only if" at :130 can be resolved now: no change.
- **M5 (plan :266) the remote status line re-words `AgentsStatusLines` by hand.** `AgentsStatusLines` (`DispatchStatus.tsx:46–66`) draws
  `{projectPaths.length} projects` and takes a full `AgentsStatus`, so a remote cannot reuse it — the plan's "same three readings" become a second home for
  those words. Acceptable (the spec :82 asks for "the same reading in the same words"), but say in the component comment that the two must be edited together,
  or split the three readings out of `AgentsStatusLines` into one helper both call.
- **M6 (plan :232) `useRefreshing.ts`' header callers list already drifts.** `client/src/hooks/useRefreshing.ts:7` lists five hooks; `.claude/rules/board.md`'s
  poller bullet lists six (`useTicks` is missing from the code comment). Since Task 4 edits that line, add `useTicks` while there.
- **M7 (plan :38) the commit trailer names a model.** The worktree's recent commits carry `Claude Opus 5.5`; this session's reminder says `Claude Fable 5.1`.
  The implementer's own session reminder is authoritative — say "the trailer your session reminder gives" rather than a literal.
- **M8 (plan :118) "a bare `.set-dot` rule if one exists".** It does not: `client/src/styles.css:957–959` holds only the three `.set-dot-*` rules, and the
  only other users are `DispatchStatus.tsx:30` and `daylight-contrast.test.ts:246–247`. Resolve the hedge.
- **M9 (plan :348–349, spec :191) `.claude/DESIGN.md` phrases.** Both stale phrases exist once each: "Settings is TWO pages" at `.claude/DESIGN.md:390` and
  "Settings' Local and Shared (§8.6)" at `:180`. The grep at plan :357 (`two pages`) is case-sensitive and misses `TWO`; add `-i` or `TWO pages` to it.
  `docs/subsystems/board.md:182` and `invariants.md:2111` ("Dashboards card … add/edit sheet") are caught by the `Dashboards card` term.
- **M10 (plan :31) `Chip` is a `forwardRef` const export** (`client/src/components/ui/Chip.tsx:52`), not a function declaration — no behaviour difference, noted
  only because a `grep "export function Chip"` returns nothing and the implementer may think the primitive is absent.

## Checklist results

1. **Coverage** — every spec section lands in a task (map below); every spec-named behaviour has a Task 3/4/5/6 case except the reorder (I1).
2. **Exact values** — copy strings at plan :39–45 match the spec (:80, :74, :95, :99–100, :124–125) and today's code (`DashboardsGroup.tsx:173`, `:101`,
   `tokenLine :344`); `MAX_REMOTES = 8`, 60 s poll, 4 s / 5 s budgets (`HOME_BUDGET` `dashboard-status.service.ts:49`, `REMOTE_BUDGET` `offers.service.ts:16`
   with `healthMs` ✓), `USAGE_FRESH_MS = 10 * 60_000` (`usage.service.ts:12`) ✓. Date fixtures at :221–224: 2026-10-23 is a Friday; Sat 24, Sun 25, Thu 29 ✓.
   `SETTINGS_HREF` today `'/?section=settings&settings=shared'` (`lib/dashboards.ts:20`) ✓.
3. **Paths and exports** — all Modify targets and cited lines exist (`types.ts` `MachineUsage` :1984, `agent.ts`, `usage.service.ts:12`,
   `DispatchStatus.tsx`, `styles.css:957–959`, `daylight-contrast.test.ts:246–247`, `Pill.tsx`, `dashboard-status.service.ts:76`, `dashboards.controller.ts`
   `@Get()`/`@Get('offers')`, `agents.module.ts:82–91`, `useRefreshing.ts:22`, `DashboardsGroup.tsx:131–133` and `:17–56`, `DashboardSheet.tsx:38` `ticked`,
   `settings.ts:49,286`, `SideRail.tsx:392`, `deep-link.ts:10`, `SettingsView.tsx:122–131/145/167–190`, `run-on.test.tsx:102`,
   `settings-view.test.tsx:205–242`, `settings-dashboards.test.tsx:125–600`, dead CSS `styles.css:1382–1399`, docs/rules lines). All Create targets absent ✓.
   `dispatchDotTone`, `USAGE_FRESH_MS` in `shared/agent.ts`, `MachineHealth`/`MachineStatus`/`MachinesStatus`, `Pill.off`, `healthOf`, `MachinesService`,
   `useMachines`, `fetchMachines`/`machineIds`/`pickSelected`/`statusFor`/`resetClockText`/`noUsageText` — none exist yet ✓.
4. **Names across tasks** — Task 1 types consumed by Tasks 3/4 with the same spelling; `dispatchDotTone` return `'live'|'paused'|'crashed'|null` ⊂ `DotTone`
   (`ui/Dot.tsx:1`) and `Dot` takes `tone?: DotTone` (`:36`) so `?? undefined` type-checks; `AgentsStatus` (`types.ts:866–885`) is assignable to
   `MachineHealth` ✓; `useMachines().reload` consumed by Task 5; `DashboardsPage` consumed by Task 6; `SettingsScope` widening reaches `readDeepLink`
   through `SETTINGS_SCOPES.includes` (`deep-link.ts:31`) with no code change, as the spec says.
5. **Ordering** — 1 → 2 → 3 → 4 → 5 → 6 → 7 with no forward reference; Task 5 renders `DashboardsPage` in isolation before Task 6 wires it.
6. **Tests** — each new suite has a named failure (not exported / 404 / FAIL); Review Focus 1, 2, 4, 5 each have a case (:292, :293, :297 + Task 3 cases 7–8,
   :221–224); RF 3 lacks reorder (I1). Fixtures discriminate: Home 12/30, Linux 64/81, Pro 64/81, Max unreachable; `dispatchDotTone` cases differ in exactly
   one field; `resetClockText` covers same-day, next-day-after-midnight, six days, past, equal, null, unparseable.
7. **Conventions** — behaviour and signatures only, no literal code; "Any size mentioned is a soft target" (:21); jsdom docblock, `listenLoopback`, flat
   `test/` all stated (:34–35); per-task suite runs, never `pnpm test` (:36).

## Coverage map (spec → plan)

| Spec section (lines) | Plan task |
| --- | --- |
| Band (:60–61) | Task 6 :333–334 |
| Suggest card (:63–69) | Task 5 :256–259 |
| List (:71–75) | Task 5 :260–263 |
| Detail head / status line (:77–83) | Task 5 :264–267 |
| Health dot, one predicate (:85–93) | Task 1 :99–122 |
| Usage, reset clock, no-figure lines (:94–101) | Task 4 :205–209, Task 5 :267–268 |
| Models and efforts, `Pill` off (:102–105) | Task 2, Task 5 :268–270 |
| Facts grid (:106–108) | Task 5 :270–271 |
| Footer (:111–112) | Task 5 :272–273 |
| Selection (:114–117) | Task 4 :203, Task 5 :253–255 — reorder missing (I1) |
| Widths (:119–120) | Task 5 :276–277 |
| States (:122–129) | Task 5 :274–275, :292, :298 |
| Server route (:131–153) | Task 3 |
| Client polling (:155–156) | Task 4 :211–214 |
| Changes to existing pieces (:160–175) | Tasks 1, 2, 6 |
| Invariants and docs (:177–192) | Task 7 |
