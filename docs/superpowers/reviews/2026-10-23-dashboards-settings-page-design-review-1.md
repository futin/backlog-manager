# Review 1 — Settings › Dashboards page design

Document: `docs/superpowers/specs/2026-10-23-dashboards-settings-page-design.md` (214 lines, commit `f9218b3`).
Reviewer: Fable (doc-review subagent), 2026-10-23. Code read at `main` + that one docs commit (`git log main..HEAD` is the spec commit alone).
Rules opened: `CLAUDE.md`, `.claude/rules/board.md`, `.claude/rules/dispatch-watchdog.md`, `.claude/rules/tests.md`, `.claude/DESIGN.md` §8.6–8.7,
`docs/subsystems/invariants.md` "Settings is two pages" and "dashboards.json has exactly one writer".

## Verdict

**APPROVE WITH FIXES.** No Critical finding. The page, its states, the parity table and the server route are sound; what needs fixing before a plan is
written is a handful of places where the spec quotes copy or names a primitive that the code it says to reuse does not produce, two internal
contradictions (the strategy picker; "usage is not read for an unreachable machine" against "health and usage run in parallel"), and one ambiguity in the
dot predicate that would let the list dot and the status-line dot disagree.

## Important

### I1 — spec:64-66, :54, :188 contradict :198 on the strategy picker

The body (:64) and the parity table (:188, "`Segmented` + selected line, a11y kept") draw the strategy picker as a `Segmented` `pill`; the settled section
(:198) records that `Segmented` is `role="group"` + `aria-pressed` and rejects radiogroup semantics, so the radios stay. The code agrees with :198
(`client/src/components/ui/Segmented.tsx:14-15`, :47-49). A builder reading the body or the table alone builds the thing the spec already decided against.
Also open: :64 says the row's hint is the *selected* strategy's line only, while today every radio carries its own line through `aria-describedby`
(`client/src/components/settings/DashboardsGroup.tsx:286-308`); keeping "today's radios" (:198) means keeping all three lines or saying which description the
unselected options lose.
→ Rewrite :64-66 and :188 to the settled form — radios restyled under the page's own class — and state whether the three per-option lines survive.

### I2 — spec:85-90: "today's dispatch-health reading for Home" is two readings that disagree

`DispatchStatus.tsx` holds two expressions today: `dispatchDotTier` (`:24-28`) paints green on `reachable && remoteAnswer` and never looks at
`spawnAvailable`; `dispatchHealthy` (`:69-71`) needs `spawnAvailable` too and gates `DispatchSetupSteps` (`:78-79`). The spec's green ("enabled, spawn
available, remote answers on") matches the second; the status line's own dot uses the first. If the new `shared/` predicate is added beside them rather
than replacing them, Home's list dot can be amber while the status line's dot is green — the exact "two agreeing expressions" shape this repo's invariants
refuse (the resume coupling rule). The local `Dot` in `DispatchStatus.tsx:30-32` (`.set-dot`) is also a second dot home beside `ui/Dot.tsx`, which guard 7
(`test/design-guards.test.ts:308`) exists to stop.
→ Name the rungs exactly (`null`/`!enabled` → quiet; `enabled && !reachable` → red; `reachable && !(spawnAvailable && remoteAnswer)` → amber; else green)
and say that `dispatchDotTier`, the local `Dot` and `dispatchHealthy` are replaced by the shared predicate — `DispatchSetupSteps` included.

### I3 — spec:91-92: the reset copy is not what the helper it says to reuse produces

`resets 23:39` / `resets Sun 05:59` are absolute clock times for both windows. `fiveHourResetText` (`client/src/lib/dashboards.ts:191-195`) returns a
relative span — `5 h resets in 2h 14m` / `5 h resets now` — and covers the 5 h window only; there is no weekly helper. :209 restates the absolute format
("time today, weekday + time otherwise"), so the spec contradicts itself on which the page draws.
→ Pick one. If absolute: name a new helper in `lib/dashboards.ts` (one home per derivation) for both windows and drop `fiveHourResetText` from the reuse
list. If relative: quote the helper's output and add the week sibling.

### I4 — spec:93: `last figure 14m old` is not `usageAgeText`'s output

`usageAgeText` (`client/src/lib/dashboards.ts:198-204`) yields `usage 14 min ago` (also `usage 5 s ago`, `usage 2 h ago`). The spec quotes a different
sentence while listing that helper as the thing to reuse (:92). The data side is fine — `UsageService.read` returns `usage: null` with `ageMs` once a figure
is past `USAGE_FRESH_MS` (`server/src/agents/dashboards/usage.service.ts:40-49`), so the age is available when the figure is not.
→ Quote the exact line the page draws; if it is `usageAgeText`'s, write `usage 14 min ago`; if the new wording is wanted, change the helper and say so.

### I5 — spec:196-200: "usage is not read for an unreachable machine" and "health and usage run in parallel" cannot both hold

A machine is known unreachable only once its health read has answered, so a usage read that is skipped for an unreachable machine runs *after* health —
which is how the offers do it (`server/src/agents/dashboards/offers.service.ts:65-66`: judge, then `reason === null ? usage.read(...)`). Sequential means a
remote's worst case is two 5 s budgets, not "about one" (:200). The same gate is what keeps :195 true — `UsageService.read` has no `enabled` check of its own
(`usage.service.ts:40-49`; it reads `/api/account` and `/api/usage/profile` from the machine's URL), so Home's usage with `BM_AGENTS` off is called unless
the route gates it on the health answer's `enabled`.
→ State the gate once — usage is read only when the health answer is `enabled && reachable` — and correct :200 to two budgets per machine, machines in
parallel; or, if parallel-and-discard is preferred, say so and drop :196-197's "not read". Add "`BM_AGENTS` off calls Home's usage endpoints neither" to the
route tests at :211.

### I6 — spec:127-131: Home from `statusOf` is two reads, one of them the heavy call the page never uses

`statusOf` (`server/src/agents/dashboard-status.service.ts:76-78`, body `:95-138`) reads `/api/health` AND the project map (`/api/configs`, cached
`PROJECT_TTL_MS` 60 s, `MANAGEMENT_TIMEOUT_MS` 15 s). The page needs only the three `/api/health` fields (:127) and the spec forbids a project dependency for
remotes (:130). Reusing `statusOf` for Home puts a 4 s + 15 s worst case on a route the spec says costs "about one 5 s budget" (:200), and `remoteStatusOf`
(`:90-92`) also reads the map (`:109-110`, `mapFailureIsUnreachable`), so it is not the "lightest call" either — the builder needs a health-only method on
`DashboardStatusService`, which :131 implies but does not say. `projectPaths` would also ride in Home's answer unless stripped.
→ Say the route uses one health-only read for every machine (Home's health budget 4 s, remotes 5 s), that `projectPaths` is not in the answer, and let
"home's own cache" go — `statusOf`'s cache is the project map's, which this route never touches.

### I7 — spec:115-116: the null-view copy quoted is not today's

Today's card draws `checking…` or, on failure, the row name `Unavailable` with the hint `Could not read the dashboards — <error>. This card will fill in once
the API answers GET /api/dashboards again.` (`DashboardsGroup.tsx:97-101`). The spec says "unchanged in content" and then quotes `Unavailable — <error>`, which
is neither the name nor the hint; and "This card" has to become the page.
→ Quote the two strings as they are, with "card" → "page", or state the new sentence outright.

### I8 — spec:96-98: `Chip` for models/efforts breaks the Pill/Chip rule

The models and efforts are facts (Home's narrow nothing, :97; editing is the sheet's). `Chip` is the 32 px control "a person clicks" (`ui/Chip.tsx:8-10`),
and `Pill` exists precisely because "nothing here is clickable" (`ui/Pill.tsx:9-12`); drawing a row of non-interactive `Chip`s is a button that does
nothing, which is the look-versus-behaviour drift §8.2 and guard 7 police. `Pill` has five tones and no "off" one (`Pill.tsx:4`), which is probably why the
spec reached for `Chip`.
→ Draw them as `Pill`s and give "off" a treatment within the primitive (a `muted`/`off` prop on `Pill`, one home), or make them real controls that open
the Edit sheet — but not a `Chip` that is not a control.

## Minor

- **spec:124-125** "in prefer order": `machines()` returns configured order (`dashboards.service.ts:60-91`); prefer order is `settings().order` applied by the
  offers (`offers.service.ts:70-75`). The client's `ids` derivation (:71) already orders by `view.order`, so say which side orders — the route sorting is
  harmless, the client's is what the list draws.
- **spec:124** "unguarded like every GET": every route is Host-allowlisted (`server/src/allowed-hosts.ts`); say "no `SameOriginPostGuard`, like every GET".
- **spec:89 vs :129**: Home's health is read twice while the page is open — `useAgents` (`/api/agents/status`) and the new route both call home's dashboard.
  Harmless, but say that the page ignores the route's Home status (only its usage) so the two cannot be read as a disagreement.
- **spec:108** "another tab's write arriving in a fresh view": `useDashboards` reads once on mount and never polls (`client/src/hooks/useDashboards.ts:8-10`),
  and the new hook polls the machines route, not the view — so a fresh view from another tab only arrives on focus if the page also re-reads
  `GET /api/dashboards`. Either say the page's poll refreshes the view too, or drop the clause.
- **spec:149** `settings=dashboards` is accepted the moment `SETTINGS_SCOPES` grows (`client/src/lib/deep-link.ts:30` uses `SETTINGS_SCOPES.includes`); the
  work is the doc comment at `deep-link.ts:9-11` ("`shared` or `local`", "points at the Dashboards card") and `test/deep-link.test.ts:33-45`.
- **spec:150**: `test/run-on.test.tsx:102` pins the old href; list it with the `SETTINGS_HREF` tests at :211.
- **spec:160-166** the doc sweep is wider than listed: `.claude/rules/board.md:47-53` mechanism text says `settingsScope` is `local | shared`;
  `docs/subsystems/invariants.md:3121` says the same in the section body and `:3203` says "Settings (Local, Shared)"; `.claude/DESIGN.md:390` opens with
  "Settings is TWO pages". `CLAUDE.md:58-66` does not name Settings' pages (only "the `Trackers` card on Shared Settings", `:64`, which stays true), so the
  "if it names" at :166 resolves to no change there.
- **spec:85-87** colours, not tones: `DotTone` has no green/amber/red; the members are `live` (`--fill-live`), `paused` (`--mustard`), `crashed` (`--red`) at
  `client/src/styles.css:3031-3033`, and `done` is a second green. Name the three the page uses.
- **spec:72** a `this machine` pill on Home's row beside the band's `this machine` scope pill uses one phrase for two readings (the host the page writes to; the
  machine that is this host). Same referent here, but `home` would not need the thought.
- **spec:211** "the moved `settings-view` assertions": today's card suite is `test/settings-dashboards.test.tsx`; `test/settings-view.test.tsx` holds the
  page-level ones. Name both.
- **spec:19** vs `RAIL_SCOPE_LABEL` (`SideRail.tsx:392-395`): fine as written; just noting the label map is typed `Record<SettingsScope, string>`, so the
  compiler forces the new entry — no test needed for that half.

## Verified true (no finding)

- Band copy and the scope pill (`SettingsView.tsx:123-131`); the 1100 px fold (`styles.css:889`); `MAX_REMOTES` 8 and the `at most 8 dashboards` title
  (`DashboardsGroup.tsx:65`, `:215-225`); the aria-labels and `Confirm` sentence (`:160-203`); the token sentence (`:344-346`); `BM_AGENTS_URL` tag
  (`:352-368`); `ids`' two repairs (`:131-133`); the `busyRef` guard (`:112-128`); `thresholdNonce` (`:310-327`); `Saved to <file>` (`:329-333`).
- `Meter` takes `width: 'fill'` and three tones (`ui/Meter.tsx:28-36`); `Dot` has the quiet no-tone reading (`ui/Dot.tsx:29-39`); `Sheet`/`SettingsGroup` exist.
- `/api/health` carries `remoteAnswer`, `spawnAvailable`, `spawnMaxPermission` (`dashboard-status.service.ts:53-57`); `cfg.enabled` false is a no-fetch
  short-circuit (`:106`); remotes inherit `enabled` from home (`dashboards.service.ts`, remote `cfg`).
- `USAGE_TTL_MS` 60 s, `USAGE_FRESH_MS` 10 min, `USAGE_TIMEOUT_MS` 5 s (`usage.service.ts:8-12`); `REMOTE_BUDGET` 5 s (`offers.service.ts:15-16`).
- Unreadable file → `machines()` answers Home only (`dashboards.service.ts:60-91`), matching :137.
- The new route stays inside `agents/dashboards/`, so no fourth outbound module (`.claude/rules/dispatch-watchdog.md`, dashboards bullet).
- `test/claude-rules.test.ts` holds the headline byte-equal across the three homes (`.claude/rules/tests.md`, first bullet), as :162 says.
- Scope: nothing in scope depends on the non-goals; the dropped per-project rows (:25-27) are correctly identified as `offers?project=` answers.
