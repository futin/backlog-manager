# Review 2 — Settings › Dashboards page design spec

Document: `docs/superpowers/specs/2026-10-23-dashboards-settings-page-design.md` (at commit a341362, after review 1's fixes).
Reviewer: fresh subagent (Fable), read-only. Every code claim below was checked against the worktree, which is byte-identical to `main` except for the
spec and review 1 (`git diff --stat main..HEAD`).

## Verdict

**APPROVE WITH FIXES.** No Critical finding. Four Important findings, all of them places where the spec is silent or ambiguous about something the builder
will otherwise have to decide alone — and in two of them the obvious decision is wrong. The design itself is sound and consistent with the multi-dashboard
spec it follows; review 1's eight fixes all landed.

## Important

- **I1 — spec:60-61 vs spec:164 — the Band's title is ambiguous.** :60 says "Band. `Dashboards`, subtitle …", reading as a Band whose TITLE is
  `Dashboards`. Today the Band's title is the fixed word `Settings` on both pages and only the subtitle and the scope Pill change per page
  (`client/src/components/settings/SettingsView.tsx:122-131`: `<Band title="Settings" sub={shared ? '…' : '…'}>` with `<Pill tone="neutral">{shared ?
  'this machine' : 'this browser'}</Pill>`), and :164 says the Band gets "a third subtitle and the `this machine` pill" — i.e. title unchanged. Both
  readings are plausible and they produce different pages. `test/settings-view.test.tsx:205-242` pins the current title and pill.
  → State it once: either the title stays `Settings` on all three pages and the subtitle names the page, or the title becomes the page name on all three.
  Not one rule for Dashboards and another for Local/Shared.

- **I2 — spec:113-116 and spec:202 — "re-read `GET /api/dashboards` on window focus" has no home and is shadowed by a pattern the spec keeps.**
  The only reader of `GET /api/dashboards` is `useDashboards` (`client/src/hooks/useDashboards.ts:7-11`), which reads ONCE on mount and deliberately has no
  focus trigger ("A burst of useRefreshing's focus reads would cost a request per tab switch…"); it is shared by `DashboardsGroup.tsx:72`,
  `BoardView.tsx:144` and `RunsView.tsx:504`, so adding a focus trigger there changes the board and Runs too. The spec's "Changes to existing pieces"
  (:156-169) never names the hook. Separately, the parity row at :202 carries over "fresh view after every write" as **Unchanged**, which today is
  `const view = written ?? loaded` (`DashboardsGroup.tsx:74-76`, justified there by "the hook reads once on mount, so the latest answer simply outranks
  it"). Once the page re-reads on focus, `written ?? loaded` makes every focus re-read after the first write invisible — `written` outranks it forever.
  → Say where the focus re-read lives (the page's own `useRefreshing`-driven read of `GET /api/dashboards`, not a change to `useDashboards`), and that the
  page holds ONE view state that both a write's answer and a re-read set, replacing `written ?? loaded`. Change the :202 row from Unchanged accordingly.

- **I3 — spec:171-181 — the doc sweep omits the rules file the new route lives under, and the new route breaks a promise written in two places.**
  `server/src/agents/dashboards/*` is scoped by `.claude/rules/dispatch-watchdog.md` (paths `server/src/agents/**`, `shared/agent.ts`), whose dashboards
  mechanism (:105-127) enumerates the module's routes (`GET /api/dashboards`, `GET /api/dashboards/offers`, the four POSTs) and says of the `default`
  source "home only, no remote, no picker anywhere, and `GET /api/dashboards/offers` fetches no usage". `offers.service.ts:25-28` carries the same
  "home-only promise … no usage fetched at all". The spec's route (:130-152) reads Home's usage whenever Home is `enabled && reachable`, including in a
  home-only setup — a deliberate and reasonable choice for a Settings page, but it is neither stated as a departure nor is the rules file in the sweep.
  (:126 of that file also holds the 5 s / 4 s / 15 s budget rule the spec's :138-146 obeys — worth citing, since it is the rule, not just a service constant.)
  → Add `.claude/rules/dispatch-watchdog.md:105-127` to "Invariants and docs touched" (route list + a sentence that `GET /api/dashboards/machines` reads
  Home's usage even when the source is `default`), and state that departure in the route section.

- **I4 — spec:169 — "the `.dash-*` rules … that only the old card used go" names the wrong set.** Of `client/src/styles.css:1382-1399`, `.dash-machine`,
  `.dash-line`, `.dash-strategies`/`.dash-strategy`/`.dash-strategy-text` and `.dash-threshold` are the card's; but `.dash-field`, `.dash-text`,
  `.dash-checks`, `.dash-check`, `.dash-actions`, `.dash-sheet-foot`, `.dash-sheet-note` (:1386-1394) are `DashboardSheet`'s, which the spec keeps (:42-43),
  and `.dash-check input, .dash-strategy input` is ONE shared rule (:1391). A builder deleting by prefix breaks the sheet; one deleting by grep of the card
  leaves the shared rule half-dead. → Name the rules that go (`.dash-machine`, `.dash-line`, `.dash-strategies`, `.dash-strategy`, `.dash-strategy-text`,
  `.dash-threshold`, and the `.dash-strategy input` half of :1391) or say "those `DashboardSheet` does not use".

## Minor

- spec:53-54 — `SettingsGroup` is listed as a primitive beside `SettingsRow`; both live in `client/src/components/ui/SettingsRow.tsx` (:76 and :40). There
  is no `ui/SettingsGroup.tsx`. Harmless, but the builder will look for the file.
- spec:85-92 — the health dot replaces `dispatchDotTier`, `dispatchHealthy` and the local `Dot` (`DispatchStatus.tsx:24-31, 69-71`); its CSS
  `.set-dot-green/amber/gray` (`client/src/styles.css:957-959`) goes with it. Not named.
- spec:85-92 — the new predicate's third rung paints `enabled && !reachable` red, where today's `dispatchDotTier` paints it gray and `AgentsStatusLines`
  reads "unreachable" (`DispatchStatus.tsx:24-27, 46-66`). A decided change (review 1, I2), fine — but the spec should say the Shared page's dispatch
  lines change colour too, since they will draw the same shared predicate.
- spec:153-154 — "armed only while the page is shown": the page component unmounts when the rail shows Local or Shared (`SettingsView.tsx:145` draws one
  page), so the poll stops by unmount, not by `armed`. Either is correct; say which, because `useCoalescedFetch`'s `armed` is the invariant's word.
- spec:173 — the invariants.md heading `## Settings is two pages, the page is the scope` (:3119) is also an ANCHOR, linked from `CLAUDE.md:231`,
  `.claude/rules/board.md:53` and `docs/subsystems/board.md:500`. Renaming the headline renames the slug; all three links move with it. `board.md` is in
  the sweep (:178), the link line is not named.
- spec:175-180 — three more "two pages" / "Dashboards card" mentions outside the listed sweep: `.claude/DESIGN.md:180` ("Settings' Local and Shared
  (§8.6)"), `.claude/DESIGN.md:404` ("since the Dashboards card stopped editing in place `DashboardSheet`"), `.claude/rules/board.md:13, :17` ("the
  Dashboards card's add/edit sheet"), `docs/subsystems/board.md:38` ("Settings (Local, Shared)"). The sheet still exists, so :404 and board.md:13/17 may
  stand with "page" for "card"; :180 and board.md:38 must change.
- spec:226 — `test/settings-view.test.tsx:205-230` ("the two pages (task-42)") and :237-242 (scope pill) are the suites that become three-page; the
  spec says tests are the builder's but these two go red on the first commit, worth naming. `test/run-on.test.tsx:102` pins `SETTINGS_HREF`'s current value
  and must follow :161.
- spec:19 — `RAIL_SCOPE_LABEL` is typed `Record<SettingsScope, string>` (`SideRail.tsx:392-395`), so widening `SettingsScope` makes the typecheck demand the
  third label; the spec's "SideRail … a third entry" is right, and the type does the reminding. No change needed; noting that :157's "every `switch`" is
  not a `switch` but this record.
- spec:97 — "`no fresh figure · usage 14 min ago`": `usageAgeText(14 * 60_000)` → `usage 14 min ago` (`client/src/lib/dashboards.ts:209-215`), correct.
  The separator ` · ` is the strip's; fine.

## Verified true (no finding)

- Copy: Confirm "Remove {label}? Launches can no longer go there; its token stays in .env." (`DashboardsGroup.tsx:165-175`); chip aria-labels (:179-199);
  "Add dashboard" title `at most ${MAX_REMOTES} dashboards` with `MAX_REMOTES = 8` (:65, :215-225); the null-view sentence (:86-106); the token line
  (:344-346); the lead line (:235); the three STRATEGIES lines (:58-62); Threshold `NumberField` min 1 max 100 unit `%` (:310-327).
- Budgets: HEALTH_TIMEOUT_MS 4 000 and MANAGEMENT_TIMEOUT_MS 15 000 (`dashboard-status.service.ts:20-22`); USAGE_TIMEOUT_MS 5 000, USAGE_TTL_MS 60 000,
  USAGE_FRESH_MS 10 min (`usage.service.ts:8-12`); REMOTE_BUDGET 5 s (`offers.service.ts:15-16`). Spec's worst-case sums (home 4 + 5 = 9 s; remote
  5 + 5 = 10 s, machines parallel) recompute.
- Usage gating: `UsageService.read` has no `enabled` check (:40-49) and returns `usage: null` with `ageMs` once stale, so the spec's "gated on `enabled &&
  reachable`" (:140) is the caller's job as the spec says, and the `usage 14 min ago` fallback is reachable.
- `judge` returns `off` before any call when `!cfg.enabled` (`dashboard-status.service.ts:95-137`); `machines()` orders Home first then configured order
  and sets remote `cfg.enabled = homeCfg.enabled` (`dashboards.service.ts:61-91`); `unreadable` → home only (:106-108). Matches :133-137, :148.
- Four write routes, each `SameOriginPostGuard` (`dashboards.controller.ts:44-65`); `@Get()` and `@Get('offers')` (:27, :37) — the new `GET machines`
  is read-only and the writer count is unchanged (:150, parity :183-206).
- `SETTINGS_HREF = '/?section=settings&settings=shared'` (`lib/dashboards.ts:20`); deep-link `SETTINGS_SCOPES.includes` (`deep-link.ts:30`);
  `pickOne(s.settingsScope, SETTINGS_SCOPES, …)` (`settings.ts:343`) — widening `SETTINGS_SCOPES` carries through both.
- `.set-cols` fold `@media (max-width: 1100px)` (`styles.css:889`) — :118 right.
- `Segmented` is `role="group"` + `aria-pressed` (`ui/Segmented.tsx:47-53`), so keeping radios for a one-of-three choice (:64-69) is the right call
  (review 1, I1).
- `Pill` tones neutral|live|warn|bad|done (`ui/Pill.tsx:3`); `Dot` tones (`ui/Dot.tsx:1,36`); `Meter` {label,value,fraction,tone,width} (`ui/Meter.tsx:23-35`);
  `RunOn.tsx:85-118` draws `5 h`/`week` meters with `usageTone` — the spec's meters (:93-100) reuse these exactly.
- `Confirm` is on the Escape stack (DESIGN.md:411; `useDialogEscape.ts`) — :126 right.
- Design guard 7 families (`test/design-guards.test.ts:308`) include `.ui-dot`, `.ui-pill`, `.ui-meter`, `.ui-seg` — the spec's "one home per primitive"
  claim at :53 is enforced.
- `test/claude-rules.test.ts` holds headlines byte-equal across the three homes — :173-174 right.
- Multi-dashboard spec `2026-10-22-multi-dashboard-design.md` has no "Settings" heading of its own (the Settings card is under "How it fits the existing
  pieces (decided)", :120), so :3's "whose 'Settings' section" is loose but findable. Not a finding.
- CLAUDE.md invariants respected: browser never talks to a dashboard (the route is server-side), `dashboards.json` single writer, every route under
  `/api`, Host allowlist, `useCoalescedFetch` single-flight, Escape owner.
