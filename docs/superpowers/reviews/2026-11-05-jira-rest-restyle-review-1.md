# Plan review 1 — `docs/superpowers/plans/2026-11-05-jira-rest-restyle.md` (plan 2 of 4)

Reviewed against `docs/superpowers/specs/2026-11-05-app-restyle-design.md`, plan 1 / its spec for the interfaces plan 2 consumes, plans 3–4 for what they
consume from plan 2, and the code at `main` (f38145ec). Every code claim below was read, not taken from the plan.

## Verdict: APPROVE WITH FIXES

No Critical finding. Seven Important findings — five are test values or stated facts that are wrong against the code or the fixtures, two are gaps an
implementer would have to guess. All are one-line fixes to the plan.

## Checklist results

1. **Coverage** — every spec section in scope maps to a task: §4.1 stripe/tones (T1), glyph tile (T1), Segmented counts (T2), FilterBar restyle (T3),
   SplitChip reuse (T4); §4.2 (T5); §4.3 (T6); §4.4 (T8, T9); §4.5 sheet (T7) and deck (T4); §9 §8.9.1/§8.9.3/§8.9.5 (T10); §8's "last task is
   `/ui-verify`" (T11). Spec §8 test cases for this scope (FilterBar restyle incl. `:271/:361/:420`, Segmented counts, Session cell / State column words,
   guards) all have a task. One spec requirement has no task line: §4.4 "scopes are not served and are not drawn" (finding I-5).
2. **Values** — copy strings match the spec (`Connected as <name>`, `Healthy`, `No sessions on <board> in the last 24 hours`, `No linked sessions`,
   `Go to the board`, `Show 30 days`, `End to end` / `Ticket loaded` / `A skill`, `N on this machine`, `Starts in microservice on a new worktree`,
   `Start session`, `Open worktrees beside this checkout`, `Skills on this machine · N`, `Make default`, `Saved in this browser.`, `(default)`).
   Two test values are wrong against the fixtures (I-1, I-2).
3. **Reality** — every Create path is absent and every Modify path exists. Cited line numbers are exact for `Segmented.tsx:28`, `FilterBar.tsx:61-140,202-215`,
   `JiraSessionCard.tsx:69-124,183-203`, `JiraAgentDeck.tsx:52-90`, `useDialogEscape.ts:47`, `board.md:20`, `invariants.md:2242`, `DESIGN.md:415`,
   `dialog-count-docs.test.ts:94`, `JiraBoardView.tsx:147,188,214-221`, `jira-deck.ts:112-131`, `jira-list.ts:276`, `JiraSessionList.tsx:63-150,250-330`,
   `JiraLaunchSheet.tsx:250-410`, `jira-launch.test.tsx:219,236`, `jira.ts:483`, `JiraReposGroup.tsx:219-315`, `JiraWorktreeRow.tsx:18`,
   `SettingsView.tsx:546`, `jira-detail.test.tsx:473,694-727,703,724-725`, `jira-list.test.tsx:179-180,271,289/291,354,361,420/423`,
   `design-guards.test.ts:323,380-396`, `daylight-contrast.test.ts:393`. Stale: the `jira-board.test.tsx` List block (M-1), `jira-lib.test.ts:1593-1615`
   (M-1), `jira-setup.test.tsx:982-1025` (I-5). `JiraSessionState` has nine members and `OrchestratorRun['status']` five (`shared/jira-sessions.ts:7`,
   `shared/types.ts:2094`) — the nine/five case counts hold. No `phase` field exists on `DashboardRow` (`shared/types.ts:896-960`), so "no phase is served"
   is right.
4. **Interfaces** — `Glyph` / `GlyphName` (plan 1 T1), `SplitChip` props (plan 1 T1: `label`, `labelMore`, `disabled`, `size`, `moreRef`), `.jira-card-type` /
   `.jira-card-prio` / `.jira-card-av` / `.jira-status-dot` / `statusTone` / `JiraTypeIcon` (plan 1 T3), `JiraRunMenu({ issue, onPick, home })` (plan 1 T2),
   `Fact icon` (plan 1 T5) — all produced with the spelling plan 2 uses. Plan 3 consumes `GlyphTile` (sizes 18/32, tones), `runTone`, `Segmented count`,
   `SplitChip href`; plan 4 consumes `type StateTone` from `client/src/lib/tones.ts` and `GlyphTile tone="ink"` — all produced here with those spellings and
   types. The glyphs plan 2 uses (`play`, `document`, `sparkle`) are in plan 1's `GlyphName`. Plan 3 adds `SplitChip.mainBlockedBy` later; plan 2's `href` /
   `variant` do not collide with it. Popover count: plan 2 says nine (SessionOpen), plan 3 moves nine → ten (Merge) — consistent end state, though the spec
   §3 numbers them the other way round (M-2).
5. **Order** — no task consumes a later task's output; T5's `listDotTone` deletion is correctly deferred to T6; T10 after T4 for §8.7.
6. **Tests** — each task's Step 1 would fail before Step 3 (new exports, new names, new attributes). Review Focus 1–5 each have a test (RF1 T4, RF2 T4, RF3 T5,
   RF4 T7, RF5 T6 unit + component) — RF1's phone half and RF2's three-row case are thin (M-5, M-6). Fixtures discriminate: nine session + five run tone
   cases, three `boardRowLine` boards, two `/a/api` + `/b/api` paths, 2 h vs newer ended links.
7. **Conventions** — behaviour and cases only, no literal code; "line counts are soft" stated at :21; wrapped at 160.

**Guards.** Guard 7 (`test/design-guards.test.ts:380-396`): every `.ui-*` rule the plan adds is said to sit inside the block (:28-31); `.ui-seg-count` is
prefix-covered by the existing `.ui-seg` family (:338) so appending it is unnecessary but harmless; `.ui-stripe` and `.ui-glyph-tile` are new families (:71).
`tr.ui-stripe > :first-child` is a block rule. The page-side `.jira-issues-row:hover` / `:focus-within` opacity rule names no `ui-*` token. PINNED
(`daylight-contrast.test.ts:393-411`, extraction at :135-151): `tintSites()` reads every `background: color-mix(in srgb, var(--X) N%, var(--strip|--steel))`
in the stylesheet and `toEqual` demands the full set, so the four new tint sites (three `GlyphTile` tones, `.jira-setup-av`) must all be pinned — the plan
pins exactly those four (:72-73, :267); `neutral` (`--strip-hi`) and `ink` (`--ink`) are one-token fills, not tints, and stripes/dots are marks — correct.
`test/run-pulse.test.ts` pins `useOrchestratorRuns()` callers; plan 2 adds none. `dialog-count-docs.test.ts:94` is the `seven composers` match plan 1 moves
to eight and T4 to nine. CSP: `Meter` and the Sessions ctx bar set width through React's `style` prop (CSSOM), as today; the plan adds no `<style>` and no
markup `style=`. `.claude/rules/tests.md`: new suites are flat `test/*.test.ts(x)` ✓; T6's fixtures use `hoursAgo`/`daysAgo` relative dates ✓.
`.claude/rules/board.md:20` is the composer sentence T4 edits ✓.

## Important

- **I-1** plan:182 — `:1344 expects `Working · 2m` (the link's age)`. The fixture is `linkOn('PAY-162', 's162', 'working', 2)` whose `h` is HOURS
  (`test/jira-board.test.tsx:1294-1297`, `hoursAgo(h)`), and `runLink` sets `stateSince: l.startedAt` (`:162-166`), so `pollAge(since)` reads `2h`
  (`client/src/lib/tracker.ts:37-44` → `elapsedSince`). → `Working · 2h`.
- **I-2** plan:288 — `:776 base placeholder `develop (default)` with the fixture refs`. The suite's `refsAnswer` carries `defaultBase: 'main'`
  (`test/jira-setup.test.tsx:161-171`); `develop` at :773 is the STORED base (the field's value), not the refs' default. → `main (default)`.
- **I-3** plan:278 — "one row per mapping — project key Pill, path mono, then a toggle Chip `N worktrees` … then fields `Base branch` and `Branch name`".
  Today the key+path row is per mapping, but the defaults fields and the worktree list are drawn once per PATH, on its first appearance in key order
  (`JiraReposGroup.tsx:140-148`, `shownDefaults`), and `jira-setup.test.tsx:899-926` maps `/home/ada/pay` under PAY and OPS and expects ONE trees block. As
  written, an implementer draws the toggle and fields under both rows. → State that the toggle and the two fields keep today's once-per-path rule (first
  appearance), and name the test that pins it.
- **I-4** plan:233-234 — "Repository: a `Segmented label="Repository"` of basenames … for 2–4 paths". Today the multi-path control starts UNPICKED
  (`choose…`, `JiraLaunchSheet.tsx:335-340`; `jira-launch.test.tsx:246` "several paths are mapped and none is picked"), and the gate reads that. The plan
  does not say what the Segmented shows before a pick (no option pressed? first path pre-picked?) — the first changes a POST payload the plan says is
  unchanged. → State: no option pressed until the person picks; the gate and `Start session` behave exactly as with the select's empty value.
- **I-5** plan:264-267 — Setup cases at `:982-1019` "read the banner". The Connection describe starts at `:978`, and the case at `:978-988` asserts the three
  scope names (`read:jira-work`, `write:jira-work`, `read:jira-user`, `:985`). Spec §4.4 says scopes are not served and are not drawn, and the plan's banner
  (`<site> · <tokenKind>`) draws none, but no plan line says that assertion goes. → Add: the scope loop at `:985` is deleted (spec §4.4), the token row is
  `<site> · <tokenKind>` only; fix the range to `:978-1019`.
- **I-6** plan:137 — "a 4 px `Meter`". `Meter` takes `label`, `value`, `fraction`, `tone`, `width` and no height (`client/src/components/ui/Meter.tsx:23-36`);
  its height is the block's `.ui-meter` rule, and guard 7 forbids `.jira-deck-ctx .ui-meter` on the page side. The implementer must guess between a new
  `Meter` prop and a structural selector. → Say which: e.g. `Meter` gains `height?: 4 | 6` (default today's), written as `data-height` and styled in the block.
- **I-7** plan:120 — `SplitChip` `href` makes the main half an `<a>`, and :133 "`busy` disables both halves" via plan 1's `disabled` (both `<button>`s,
  plan 1 :58-64). An anchor has no `disabled`; the plan does not say how a busy link half is inert (drop `href` + `aria-disabled`? `pointer-events`?). → State
  it (recommend: while `disabled`, render the main half as the button form with `aria-disabled`, no `href`).

## Minor

- **M-1** plan:165, :182-184, :147-151 — `jira-board.test.tsx` List lines are ~29 low (`:1330` → `:1355`, `:1344` → `:1373`, `:1345` → `:1374`, `:1352` →
  `:1381`; `:783-786` → `:804-815`, `:802` → `:830`, `:979` → `:981`); `jira-lib.test.ts:1593-1615` → `:1621-1644`. The prose identifies each case, so
  this is navigation only.
- **M-2** plan:34, :151 — the spec (§3) calls the PR Merge menu the ninth composer and the deck Open the tenth; the plans number them the other way. Final
  count agrees (plan 3 :120 moves nine → ten). Worth a sentence so the doc edits in T4/plan 3 do not argue.
- **M-3** plan:128-129 — the spec (§4.5) says the split "collapses to the one Open button" when neither Stop nor Unlink is drawn; the plan collapses only when
  there is also no secondary Open (the Desktop/Dashboard alternative goes into the menu). This keeps today's second button, which §2 requires, but it is a
  plan/spec difference the plan's own rule (:21) says to report. Add the sentence.
- **M-4** plan:130 — "`{ kind: 'disabled'; title }`" on the MAIN half is unreachable: `primaryIsDesktop` is true only while `desktopButton(...).enabled`
  (`client/src/lib/jira-sessions.ts:86-89`), so a disabled Desktop is always the secondary. Fine to keep in the type; say it never hits the main half.
- **M-5** plan:141-146 — Review Focus 1's "a phone must still hide Desktop" has no `jira-session-open` case; add a `useNarrow` → no Desktop row case.
- **M-6** plan:141-146 — Review Focus 2's "three-row menu at most" (secondary + Unlink + Stop) is not a listed case; add one.
- **M-7** plan:83 — accessible name `Needs you 1`: with `{label}<span>` adjacent, jsdom's name computation gives `Needs you1`; today's markup keeps a space
  before the count span (`JiraSessionList.tsx:109`). Say the span follows a space (or the test will teach it).
- **M-8** plan:199 — `boardName: string` when no board is loaded (`statusAnswer = status({ boards: [] })`, `jira-list.test.tsx:415-423`): say `''` is passed
  and that the `allTickets` lead never uses it.
- **M-9** plan:105 — "no element with class `filter-bar-head`" pins a class name rather than behaviour; "no `Clear all` outside the foot row" would do.
- **M-10** plan:155-156 — the planning-time `Popover` hit list names five suites; `grep -l Popover test/` returns ~22 (board, jira-chip, releases-drawer,
  runs-view, settings-*, ui-modal …). The instruction "add any that count callers" is right; the list is not.
- **M-11** plan:71 — `'.ui-seg-count'` is already covered by the `.ui-seg` family prefix (`design-guards.test.ts:338`); only `.ui-stripe` and `.ui-glyph-tile`
  need appending (the plan appends only those two — fine — noted so nobody adds a third).
- **M-12** plan:259 — `Every` = `idle` renders `Every idle`; reads oddly but is what §4.4 implies. Taste only.
