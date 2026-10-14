# Dashboard redesign ports — execution rulings

Plan: [2026-10-14-dashboard-redesign-ports.md](../plans/2026-10-14-dashboard-redesign-ports.md). No separate spec: the reference is
`../claude-agents-dashboard`, branch `management-redesign` (the commits are listed per task in the plan). Branch `dashboard-redesign-ports`, `9a84fb5..HEAD`:
Daylight AA status tokens with marks split from text (Task 1), one `ui/Chevron` (Task 2), Daylight as the default theme (Task 3), the prompt-cursor wordmark
(Task 4), and this record plus the screenshot pass (Task 5).

Rulings made during subagent-driven execution, each as what was decided, why, and what it costs if wrong. The per-task ledger, reports and reviews lived
under the git-ignored `.superpowers/` and are not kept.

## Task 1 — Daylight status tokens

- **`--green-solid` stays `#7dc242`, although it measures 2.17:1 on `--strip`.** The plan mirrors the dashboard's vocabulary, and `#7dc242` is already
  `--fill-progress`, the value the same marks (meter fills, ramp dots, run bars) drew before the split — so the split moves no mark further from AA than it
  already was. Task 5's screenshots: the dots and the Runs page's stage bars read clearly; a meter at a low fraction is a thin pale sliver on white, which its
  label and value carry. Cost if wrong: Daylight's green dots and bars stay under WCAG 1.4.11's 3:1 for non-text marks; the fix is one value in
  `shared/theme.css`.
- **`--amber-text` is `var(--ink)` in Daylight — the dashboard's choice.** Amber text that clears 4.5:1 on white is brown, not amber, so the dashboard sets
  amber-coded text in ink and lets an amber mark beside it carry the hue. Kept only where such a neighbour is guaranteed to render (Review Focus 5):
  - `.watchdog-card-wd` — the line itself holds the attempt pips (`.watchdog-attempts i`, `--amber-solid` ring and fill).
  - `.runs-row-crashed` — this second line renders only when the row head draws `<Pill tone="warn">⚠ crashed</Pill>`.

  Cost if wrong: on those two lines a warning reads as plain body text; each is a one-token swap to `--amber-ink`.
- **Everywhere else, amber text is `--amber-ink` (`#8a5214`, ≥ 5.44:1 on all four surfaces, worst over a tint 4.82:1).** Fifteen sites. Five sit on their own
  amber tint, where ink would erase the hue the tint promises: `.board-card-stage-warn`, `.run-drawer-note`, `.orchestrate-preview-flag`, `.ui-pill-warn`,
  `.run-drawer-attn-kind` (on its parent's 6 % tint). The rest are the Review Focus 5 exceptions — nothing amber beside them is guaranteed:
  - `.set-dot-amber` — a `●` tier glyph in a Settings row, beside green and grey tiers; in ink it would read as neither.
  - `.board-warn` — the degraded-scan line above Board and Archive, which stands alone.
  - `.sheet-error`, `.sheet-blocked` — lone message lines in the Launch and Orchestrate sheets.
  - `.watchdog-warn` — `⚠ N crashed` in the Watching figure line, with no amber in that figure.
  - `.watchdog-row-crashed .watchdog-row-verdict`, `.watchdog-verdict-glyph` — the card's dot is `--red`; its amber heartbeat fill and pips are conditional.
  - `.watchdog-kind-warn` — a feed table cell with nothing amber in its row.
  - `.runs-row-attn` — `⚠ N` on a Live row; the warn pill appears only when the row is crashed.
  - `.runs-status-warn` — the History row and detail head status word (`aborted`, `crashed`), whose dot is `--ink3` or `--red`.
  - `.ui-figure-live` — no caller passes `tone="live"` today; in ink it would equal the default `ink` tone.
  - `.ui-marker-stale`, `.ui-marker-untyped` — lone card marker words; in ink, `stale` would read as a darker `kind`.

  This is the largest departure from the dashboard (15 sites brown, 2 ink, where the dashboard sets them all in ink). Task 5 judged it on a swatch built from
  the app's own classes, beside `main`'s orange: the brown reads as a warm warning colour, distinct from ink and from the dark text green, and every site that
  carries `⚠` keeps its glyph. It is less alarming than the old orange, which is the price of 4.5:1. Cost if wrong: Daylight warnings look subdued; moving a
  site to `--amber-text` is one token, but only where an amber neighbour is guaranteed.
- **`--amber` is still declared in the Daylight block.** The aliases that still read it and design guard 5 need it, and `styles.css` reads no bare
  `var(--amber)` (pinned by `test/daylight-contrast.test.ts`). Cost if wrong: a dead-looking declaration a later sweep might delete, which guard 5 would catch.

## Task 2 — one Chevron

- **`Chevron` is a named export, not the plan's default export.** Every other `ui/` primitive is named; the plan's wording mirrored the dashboard, not a board
  requirement. Cost if wrong: three import lines to flip back.
- **Drawn at 11 px where the dashboard's is 9** — the board's caret has been 11 px since DESIGN.md §8.0, and guard 3's 11 px floor is the same number.
  `.chev` joined guard 7's `FAMILIES`. Cost if wrong: two pixels per chevron.
- **The path sits off the rotation centre and was left there.** `M2 4l3 3 3-3` spans y 4–7 in a 10-unit box, so its centre is 0.5 units below the box's. Task
  5 measured it at 1280 × 900: the tracker chip's box is centred on the chip exactly (both at y 25), the path's centre is y 25.55 closed and y 24.45 open — a
  1.1 px hop on toggle that the toggle's own rotation hides. The dispatch mark (`right`) is centred vertically to the hundredth and sits 0.55 px right of its
  box. Cost if wrong: a sub-pixel nudge to one path, `M2 3.5l3 3 3-3`.

## Task 3 — Daylight the default

- **Review Focus 4's pre-paint half gets a test; the plan pinned only `clampSettings`.** The plan's own Review Focus asks that a stored Midnight survive the
  default flip, and the half that can break it first is `index.html`'s stamp. Cost if wrong: one extra test.
- **The pre-paint script stamps `daylight` before its `try`.** `theme.css`'s `:root` still holds Midnight's palette, so without the stamp a fresh browser
  would paint one dark frame. Accepted consequence: a stored blob whose `theme` names no theme is stamped as that unknown name, which has no palette block, so
  it paints `:root`'s Midnight for one frame until `clampSettings` lands on Daylight. Cost if wrong: a one-frame flash, only for a hand-corrupted blob.

## Task 4 — the prompt-cursor wordmark

- **Remote runs never blink the cursor.** `runsWorking` (`client/src/lib/run-pulse.ts`) counts a `starting` entry, or a run that is `!isRemoteRun(run)`,
  `running` and not `isCrashed`. The wordmark is a claim about this machine, and a remote run's controls are on the machine that ran it. The guard sits in
  the derivation, not in which array a caller passes, because RunsView folds remote runs into its rows through `remoteAsLive`, which keeps `remote: true`.
  Cost if wrong: the cursor stays solid while another machine drains a queue; the change is one predicate.
- **A crashed run does not blink (Review Focus 3).** `isCrashed` reads the server's `fresh`; there is no second freshness check. Task 5 confirmed it live by
  rewriting the runs payload: `running` + `fresh: true` draws `.rail-cursor.blink` with `animation-name: cursor-blink`, `running` + `fresh: false` draws a
  solid cursor beside the `⚠ crashed` pill. Cost if wrong: a dead run looks alive in the one place visible from every page.
- **The phone bar's kicker stays 11 px, not the dashboard's 10.** 10 px fails design guard 3's 11 px floor, and the guard stays — the precedent is §8.0's
  tracker meters (11 px where the dashboard draws 9.5/9). Cost if wrong: a 1 px larger kicker in the bar; the bar measured 87.77 px wide for the brand at
  375 px, with no horizontal overflow.
- **The dashboard's grey `off` cursor (`.rail-cursor.off`, poll lost the server) is not ported.** The board has no shell-level connection verdict to drive
  it; the dashboard's comes from SessionsView's `{ connected }`. Cost if wrong: the cursor stays solid green while the API is down.
- **The dashboard's favicon change is not ported**, by the plan's own decision: two tabs with one icon would be indistinguishable. Cost if wrong: nothing
  until someone wants matching icons.
- **The file is `lib/run-pulse.ts`, kebab-case like every file in `client/src/lib/`**, not the plan's `runPulse.ts`. None of the existing `run-*` files is a
  home for a presence reading. Cost if wrong: a rename.
- **`App` tags each working report with the section that made it**, beyond the plan's reset-on-change. A poll that lands just before a section click can
  flush the old view's `true` on top of the reset; the tag drops it. A click on the section already open keeps the report. Cost if wrong: one field in the
  pulse state.
- **`test/run-stage-chip-style.test.ts` now reads every reduced-motion block** (through `mediaBlocks`), not only the first. The cursor's own one-line block
  became the first in the file and broke a lazy regex; the assertion is unchanged and mutation-checked. Cost if wrong: none to behaviour.

## Task 5 — the screenshot pass

- **Headless Playwright from the npx cache, not the in-app pane**, against two Vites on spare ports proxying to the docker stack's API (`4322`): this branch
  on `5191`, `main` (in a temporary worktree with `pnpm install --offline`) on `5192`, each started and killed by recorded pid. Daylight at 1280 × 900 and
  375 × 812, Board and Runs; Midnight at 1280 × 900 on both builds, with every `/api` body replayed from one capture and the clock frozen, then
  pixel-diffed.
- **Midnight, branch against `main`:** the only changed pixels are the wordmark, the tracker chip (an 11 px chevron where a 5.27 px glyph was, so the chip is
  5.7 px wider) and each dispatch button (76.53 px against 70.84). The rail's section rows differ only by a 3 px downward shift — the new wordmark is 61 px
  tall against 58 — and are pixel-identical once shifted. Every card, column header, filter control and surface is identical. Review Focus 1 holds.
- **No horizontal overflow at 375 px** on Board or Runs (`documentElement.scrollWidth − innerWidth` = 0); none at 1280 either.
- **Found and left, because it predates this branch:** three status words take their colour from a FILL token, not a text one — `.runs-status-live`,
  `.runs-status-paused` and `.watchdog-kind-live` read `--fill-live`, which is `#F5A15C` in Daylight, about 2.1:1 on `--strip`. Task 1 left `--fill-*`
  alone by plan, and `test/daylight-contrast.test.ts` checks status text tokens only, so neither saw them. Cost if left: Daylight's `paused` and `live` words
  stay under AA.

## Deferred minors (from the task reviews, not acted on)

- `test/daylight-contrast.test.ts`'s tint case cannot see a descendant on its parent's tint (`.run-drawer-attn-kind`); `--amber-solid` is 3.01:1 on
  `--steel`, which case 3 does not list; a `shared/theme.css` comment bullet ends in a dangling colon.
- The chevron's reduced-motion rule is three `.chev-<dir>` rules rather than one, and its test asserts the exact one-line text — both workarounds for guard
  7's bare-selector count. DESIGN.md §6 still says chevrons are 12–14 px; §8.0's paragraph says 11 px here.
- The pre-paint stamp guard finds the `try` by `indexOf('try {')`, so it is spelling-sensitive; Task 3's fix round reflowed an existing CSP paragraph in
  `invariants.md` (blame churn).
- The no-fourth-poller guard catches only an assigned zero-argument `useOrchestratorRuns()` call; `App`'s section tag on the working report is untested.

## Verification at the Task 5 commit

jest 152 suites, 2703 passed / 1 skipped; node 930 passed / 0 failed / 1 skipped; `pnpm run typecheck` and `pnpm run build` exit 0.
