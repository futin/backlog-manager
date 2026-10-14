# Review 1 — `docs/superpowers/plans/2026-10-14-dashboard-redesign-ports.md`

Reviewer: Fable 5.1 (fresh subagent), 2026-10-14. Spec = the plan's stated goal plus `claude-agents-dashboard` branch `management-redesign`
(commits `e2bd082`, `e0ee53e`, `3a6661a`, `3c180a1`, `9889cc4`, `efc197c`, `e882365`, `89a46cd` — all exist and match the plan's one-line descriptions).

## Verdict: REVISE

One Critical (a stated value fails an existing design guard, so `pnpm test` goes red at the end of Task 4) and six Important findings, most of them places
where the plan's own rule and its own constraint collide and an implementer has to pick. Every value, ratio, line number and file reference I could check
is otherwise right — the plan is close.

## What was verified (no finding)

- **Values.** All token values in the Task 1 table (lines 69–80) match the dashboard's daylight block at `3c180a1` (`client/src/styles.css` l.124–137)
  and its `:root` derived defaults (l.44–62): `--green #38631a`, `--green-solid #7dc242`, `--green-tint #cde8a8`, `--amber-solid #c4761f`,
  `--amber-text var(--ink)`, `--amber-tint color-mix(in srgb,#c4761f 11%,transparent)`, `--amber-ink #945917`, `--mustard #5f530b`,
  `--mustard-tint 13% #9a8712`, `--mustard-ink #74660e`, `--cyan #306c0f`, `--ink2 #525252`, `--ink3 #6b6b6b`; dark defaults `var(--green)`,
  `color-mix(… 18%)`, `var(--amber)`, `11%`, `13%`.
- **Ratios recomputed** (WCAG relative luminance, sRGB): line 57 — green 2.92, amber 3.52, mustard 3.59, cyan 4.08, ink3 2.61 ✓; line 82 — red on
  `--strip-hi` 5.35 ✓. Every case in line 91 passes with the plan's values (tightest: `--ink3 #6b6b6b` on `--steel` 4.55). Line 92: `--amber-ink` over the
  11 % tint 5.04 on `--strip`, 4.52 on `--strip-hi`; `--mustard-ink` 4.99 / 4.51 ✓. Line 93: `--amber-solid` 3.52 / 3.15 / 3.20 ✓. `--green` over
  `--green-tint` 5.29 (not asserted by the plan — see M5).
- **Reality.** `client/src/styles.css` has exactly 64 bare `var(--green|amber|mustard|cyan)` (38/12/7/13) — line 62 ✓. `test/design-guards.test.ts:220`
  `DAYLIGHT`, `:219`/`:245` "§2.2" ✓. `TrackerChip.tsx:82-84` ▾ and `DispatchButton.tsx:304-306` ▸ are the only triangle glyphs under `client/src` ✓.
  `settings.ts:19` `THEMES` (midnight first), `:151` `theme: 'midnight'`, `:295` `clampSettings` ✓. `client/index.html:39` the `try` with `var r` inside ✓.
  `server/src/security.ts:20` `THEME_SCRIPT_SHA256`; `test/csp.test.ts:81-90` recomputes it ✓. `SideRail.tsx:56` "wordmark's dot", `:89-99` the
  `Dot` + `.rail-word` brand, rendered in exactly one place per width (`:110`/`:117` ternary) ✓. `App.tsx:107` renders `SideRail` ✓. `BoardView.tsx:270`,
  `RunsView.tsx:755`, `ArchiveView.tsx:128` each call `useOrchestratorRuns()`; `POLL_MS = 5_000` per instance (`useOrchestratorRuns.ts:19`, `:284`);
  the hook returns `starting` and `remote` ✓. `styles.css:159` `.rail-brand`, `:165` `.rail-kicker`, `:175` `.rail-word`, `:298` bar variant, `:334`
  `.tracker-caret`, `:1535` `.dispatch-mark` ✓. `.claude/DESIGN.md:174` wordmark paragraph ✓. `test/rail.test.tsx` exists and references none of the
  brand text ✓. All four Create targets absent ✓. `docs/superpowers/decisions/` exists ✓. Memory `ui-mockups` has the §Live-app layout checks ✓.
- **Guards that survive.** `themeBlocks` filters on `--board:` (`design-guards.test.ts:63`), so a new `:root{}` derived block does not become a sixth
  theme block for guard 8; guard 5 reads only the `DAYLIGHT` keys; `live-bar-style.test.ts:113` counts `--fill-live:` five times, untouched.
- **Rules.** `board.md`, `tests.md`, `security.md` scoped to the touched paths — nothing in the plan contradicts a hard rule. `shared/theme.css` has no
  rule file. The CSP-hash rule (`board.md:40-44`) is honoured by Task 3's `security.ts` entry.
- **Review Focus coverage.** RF1 → Task 1 "dark blocks derive" (but see I1); RF2 → "defaults precede daylight" ✓; RF3 → Task 4 stale-heartbeat case ✓;
  RF4 → Task 3 `{ theme: 'midnight' }` case ✓; RF5 is a judgement with a report, no test — acceptable.
- **Conventions.** No literal code anywhere; budgets soft; 160-column prose ✓.

## Critical

### C1 — plan:171 — the bar variant's 10 px kicker fails design guard 3

Line 171: "bar variant: … kicker 10 px". `test/design-guards.test.ts:179-201` ("guard 3 — 11 px is the floor") rejects every px-literal `font-size`
under 11 px in `client/src/styles.css`, with an allowlist only for non-px sizes. The dashboard's `.mnav-brand .rail-kicker{font-size:10px}` (its
`styles.css:362`) was never under that guard. `.claude/DESIGN.md:186` records the board already paying this exact tax once ("both 11 px where the
dashboard draws a 9.5 px label and a 9 px caret — guard 3's floor"). As written, Task 4 Step 4 (`pnpm test` green) cannot be reached.
→ Keep the kicker at 11 px in the bar (say so beside the other bar figures) and record the deviation in the rulings file; do not widen the guard.

## Important

### I1 — plan:85-87 vs plan:37/43 — the tint rule moves the dark themes

Line 86-87 says every "`color-mix` tint behind same-hue text → `--X-tint` with `--X-ink` on the text", and line 94's test only checks that the dark
defaults are `var()`/`color-mix` forms. But the board's tints are not the dashboard's: `.ui-pill-warn` is `color-mix(in srgb, var(--amber) 14%,
var(--strip))` (`styles.css:2672`), `.ui-pill-done` 14 % green (`:2674`), the chip rules 10 % over `--strip` (`:645-646`, `:675-676`, `:697-698`),
one 12 % over `--steel` (`:1383`), one 6 % (`:1432`), mustard 10 % (`:2088`). The plan's `--amber-tint` / `--mustard-tint` / `--green-tint` dark defaults
are 11 % / 13 % / 18 % over `transparent`. Replacing those sites with the tokens therefore changes every dark theme's computed pill fill (Global
Constraint line 37, Review Focus 1), and the "dark blocks derive" case cannot see it. The other way round — keep each site's own mix and swap only the
text to `--amber-ink` — makes the plan's line 92 premise wrong: `#945917` over 14 % `#c4761f` composited on `--strip-hi` is **4.40:1**, under AA
(4.87 on `--strip`). An implementer must choose, and both choices break something the plan pins.
→ Decide in the plan: (a) declare the board's dark defaults with the board's own mix (e.g. `--amber-tint: color-mix(in srgb, var(--amber) 14%,
var(--strip))`) and collapse the 10 %/14 % sites onto one token, listing which dark sites move and exempting them from RF1 by name; or (b) keep every
site's mix and set daylight's `--amber-tint` to the same 14 % (then `--amber-ink` fails on `--strip-hi`, so pick a darker ink or restrict pills to
`--strip`). Either way, the test in line 92 must read the tint percentage the sites actually use, and `--green` over `--green-tint` should join it.

### I2 — plan:13 vs plan:171 — Task 4 consumes Task 1's token but the plan says the tasks are independent

Line 13: "Each task is independent." Line 171: the cursor is `--green-solid`, which only Task 1 produces (line 72). Built in any other order, the
cursor has no colour (an undefined custom property) and the "cursor has `blink`" tests still pass, so nothing catches it.
→ State Task 1 as a prerequisite of Task 4 in Task 4's header, or name the fallback `var(--green-solid, var(--green))` and say why.

### I3 — plan:166 — `runsWorking(runs, starting, now)` carries a clock the one predicate does not take

Line 166 asks for `now` and for "the same predicate the board uses to tell running from crashed … do not write a second one". That predicate is
`isCrashed(run)` (`client/src/lib/run-watchdog.ts:83`: `run.status === 'running' && !run.fresh`), which reads the server-computed `fresh` flag and takes no
clock (`board.md:52-58`: `MergedRun.live` is the data authority). A `now` parameter invites exactly the second freshness computation the sentence forbids,
and the line 175 test case "stale heartbeat (crashed)" can only be expressed as `fresh: false`.
→ Drop `now`: `runsWorking(runs, starting)` = `starting.length > 0 || runs.some(r => r.status === 'running' && !isCrashed(r))`, and say the fixture is
`fresh: false`.

### I4 — plan:114-116 — the chevron's size is unstated, and the three sources disagree

The interface gives viewBox, path, classes and transition but no `width`/`height`. The dashboard draws `.chev` at 9×9 (its `styles.css:462`); the
board's own `.claude/DESIGN.md:186` drew the tracker caret at 11 px *because of* guard 3; `.claude/DESIGN.md:148` (§6) says chevrons are 12–14 px.
Width/height are not `font-size`, so guard 3 does not decide it, and the plan says "drop any font-size that only sized the glyph" (line 111) without
saying what replaces it.
→ State the `.chev` box (9 px to mirror the dashboard, or the board's 11 px) and have Task 2 rewrite the "11 px caret" phrase at `DESIGN.md:186`
(the Task 2 file list omits DESIGN.md).

### I5 — plan:158-168 — a reported `working` is never cleared when the reporting view unmounts

Line 159 has each view report `working` "up through one callback prop" and line 168 says `undefined` means not working on Settings. `App.tsx:132-145`
mounts one lazy view at a time; a `true` reported by Board stays in App's state after the user switches to Settings (which calls no poller), so the
cursor keeps blinking on a page that knows nothing — the failure Review Focus 3 exists to prevent, by a different door.
→ Specify that App resets the value to `undefined` on section change (or keys the state by the reporting section), and add the test case "Board
reported working, then Settings → cursor without `blink`".

### I6 — plan:137 — `docs/subsystems/board.md` does not name the default theme

Line 137 lists `docs/subsystems/board.md` "wherever it names the default theme". It never does: the only theme mention is `board.md:227` ("Local
holds themes, density…"), and no file under `docs/subsystems/` names `midnight` as a default. The Modify entry is a no-op as written. Related, since
the picker will now lead with it: the Daylight entry's label and hint are `'Daylight Strip'` / `'light manila paper, dark ink'`
(`client/src/lib/settings.ts:24`), false since task-36 rewrote the palette (`shared/theme.css:103-106`), and `test/settings-view.test.tsx:104` clicks
`/Daylight Strip/`.
→ Drop the board.md entry (or point it at the sentence that will exist after Task 5), and decide in Task 3 whether the label/hint follow the
dashboard's (`'Daylight'` / `'the reference light board — warm grey, white cards, green ramp'`, `e882365`) — if so, name the settings-view test.

## Minor

- **M1 — plan:64** "§1–7 stay byte-identical to the dashboard's copy" is not true today: the board's `DESIGN.md:1-3` carries its own title and a
  provenance line pinned to dashboard commit `c179ca4`. Say "§1–7 unchanged".
- **M2 — plan:82** `--red` stays `#b03b28` (and `--magenta` `#6b52a8`) while the dashboard's daylight block has `#aa3927` / `#6950a5`. Fine — line 67
  only promises mirrored *names* — but it is a value the two repos now disagree on; log it in the rulings file.
- **M3 — plan:170** The caret `›`'s colour is unstated; the dashboard sets `.rail-caret{color:var(--green-solid)}` (its `styles.css:245`).
- **M4 — plan:111/118** `.tracker-chip[aria-expanded="true"] .tracker-caret { transform: rotate(180deg) }` (`styles.css:335`) must go, or an `up`
  chevron inside the open chip rotates twice; `.tracker-caret`'s `color: var(--ink3)` (`:334`) needs a new home (the `className` prop).
- **M5 — plan:92** `--green` over `--green-tint` (5.29:1 today) is not in the test; the `.ui-pill-done` site (`styles.css:2674`) is the pair.
- **M6 — plan:179** `test/motion-style.test.ts` already drives every explicit `animation: none` override from one table (`.claude/DESIGN.md:405`);
  add `.rail-cursor.blink` there rather than a one-off case, so "only where it is needed" stays one judgement.
- **M7 — plan:137** "find it by `DEFAULT_SETTINGS`" matches five files (`settings.test.ts`, `board.test.tsx`, `launch-sheet.test.tsx`, `rail.test.tsx`,
  `settings-view.test.tsx`); name `test/settings.test.ts` and its `:266` (`expect(s.theme).toBe('midnight')`).
- **M8 — plan:36** "no hex in `client/src/styles.css`" — comments at `styles.css:727`, `:762`, `:765` carry hex; if the constraint ever becomes a test,
  strip comments first (as `design-guards.test.ts`'s `stripComments` does).
- **M9 — plan:121** Mirror the dashboard's comment stripping in the glyph scan (`test/chevrons.test.ts` `stripComments`), or a `▸` in a code comment
  (the kind `test/dispatch-button.test.tsx:121` already has) fails a component that draws none.
- **M10 — plan:85-87** `.run-stepper-dot-filled { background: var(--good) }` (`styles.css:1256`) reads the `--good: var(--green)` alias
  (`shared/theme.css:202`): a green mark the 64-use count and the pass do not see, which stays the dark text green in daylight. Fold into Task 1's pass.
- **M11 — plan:134** The dashboard also hoisted `var r` out of the `try` (`e882365`); say so, since the line 144 test regex (`r.dataset.theme = '<x>'; try`)
  assumes `r` exists before the `try`.
