# Dashboard management-redesign ports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Override of the writing-plans template:** this plan specifies behaviour, exact values and exact test *cases* — never literal code blocks (global
> CLAUDE.md § Learnings). Write the code and the test scaffolding yourself; if a value or a case here looks wrong against the code, say so in your report
> rather than transcribing it. Size targets anywhere below are soft.

**Goal:** Bring four cross-cutting changes from `claude-agents-dashboard`'s `management-redesign` branch into the board: AA-contrast status tokens in Daylight,
one shared `Chevron`, Daylight as the default theme, and the prompt-cursor wordmark.

**Architecture:** Client and `shared/theme.css` only — no server route, no skill, no item file. Run the tasks in order: Task 4's cursor reads `--green-solid`,
which only Task 1 defines; Tasks 2 and 3 stand alone. Task 1 is the largest (a token split plus a pass over every status-colour rule in
`client/src/styles.css`).

**Tech Stack:** React + Vite client, CSS custom properties in `shared/theme.css`, jest (flat `test/`) for every new test.

**Spec:** none written separately — the reference is the dashboard branch itself. Read these before the matching task (repo
`../claude-agents-dashboard`, branch `management-redesign`, `git show <rev> -- <path>`):

| Task | Reference commits | What to read there |
|---|---|---|
| 1 | `e2bd082`, `e0ee53e`, `3a6661a`, `3c180a1` | `client/src/styles.css` token blocks (`:root` defaults ~l.46–61, daylight ~l.124–137), `test/daylight-contrast.test.ts` |
| 2 | `9889cc4`, `efc197c` | `client/src/components/Chevron.tsx`, `.chev` rules, `test/chevrons.test.ts` |
| 3 | `e882365` | `client/index.html`, `client/src/lib/settings.ts`, `test/client-settings.test.ts` |
| 4 | `89a46cd` | `SideRail.tsx` `Brand`, `.rail-brand`/`.rail-prompt`/`.rail-cursor` rules |

Not ported, by decision (2026-10-14): the four Git layouts, `gitLevels`, Open PR / `originUrl`, the drop-line pin reorder, the Folder-gone chip,
`POST /api/open-folder`, and the mock re-syncs — the board has no Git view and no pins. The dashboard's favicon change is not ported either: two tabs with one
icon would be indistinguishable.

## Global Constraints

- Before editing any file, open the `.claude/rules/*.md` scoped to it: `board.md` (`client/src/**`), `security.md` (`server/src/*.ts`), `tests.md` (`test/**`).
- Every component cites its `.claude/DESIGN.md` subsection in a header comment; every look drawn on more than one surface lives in `client/src/components/ui/`.
- Every colour is a token or a `color-mix` over one — no hex in `client/src/styles.css`.
- Dark themes (midnight, graphite, amber, nightshift) must compute to exactly what they compute today. Only Daylight changes colour.
- Comments explain *why*, at the existing density. New prose wraps at 160 columns.
- `pnpm test` (both runners), `pnpm run typecheck` and `pnpm run build` green at the end of every task.

## Review Focus

1. **Dark themes unchanged.** Every new derived token must resolve, in the four dark blocks, to the value the rule used before the split. Pinned by Task 1's
   "dark blocks derive" case and checked by a midnight screenshot in Task 5.
2. **Cascade order.** A `:root{}` defaults block and `[data-theme="daylight"]` have equal specificity, so whichever comes later in the file wins. A defaults block
   placed *after* the daylight block silently undoes every daylight override. Pinned by Task 1's "defaults precede daylight" case.
3. **A crashed run must not blink the cursor.** A run whose file still says `running` but whose heartbeat is stale is crashed, not working. Pinned in Task 4.
4. **A stored theme survives the default flip.** Anyone who already picked Midnight keeps Midnight. Pinned in Task 3.
5. **Amber text that goes to ink loses its hue.** In Daylight `--amber-text` is `--ink` (the dashboard's choice). At each site moved to `--amber-text`, the
   warning must still read as a warning from a neighbouring amber mark, pill or word; where nothing else carries it, use `--amber-ink` instead and list the site
   in the report.

---

### Task 1: Daylight status tokens that hold AA

Measured today on Daylight's `--strip` (#fff): `--green` #5fa92c 2.92:1, `--amber` #c4761f 3.52, `--mustard` #9a8712 3.59, `--cyan` #3f8f14 4.08, `--ink3`
#a0a0a0 ≈2.6 — all under 4.5. The dashboard fixed the same palette by separating marks (bright) from text (dark).

**Files:**
- Modify: `shared/theme.css` (a `:root` derived-defaults block; the `[data-theme="daylight"]` block and its comment)
- Modify: `client/src/styles.css` (every `var(--green|amber|mustard|cyan)` — 64 uses today)
- Modify: `test/design-guards.test.ts` (the `DAYLIGHT` map, ~l.220)
- Modify: `.claude/DESIGN.md` §8.2 (the daylight note — leave §1–7's body untouched; it matches the dashboard's below the board's own title lines)
- Create: `test/daylight-contrast.test.ts`

**Interfaces — produces (token names, mirrored from the dashboard so the two repos stay one vocabulary):**

| Token | Role | Dark blocks (derived default) | Daylight |
|---|---|---|---|
| `--green` | text | unchanged | `#38631a` |
| `--green-solid` | dots, bars, meters, borders | `var(--green)` | `#7dc242` |
| `--amber-solid` | marks | `var(--amber)` | `#c4761f` |
| `--amber-text` | amber figures and words | `var(--amber)` | `var(--ink)` |
| `--amber-ink` | amber text on an amber tint (pills, notices) | `var(--amber)` | `#8a5214` |
| `--mustard` | text and marks | unchanged | `#5f530b` |
| `--cyan` | text and marks | unchanged | `#306c0f` |

No `--X-tint` tokens, unlike the dashboard (review 1): the board's ten tint sites each carry their own mix — 6/10/12/14 % over `--strip` or `--steel`
(`styles.css:646, 676, 698, 1192, 1383, 1432, 2088, 2102, 2672, 2674`) — and one token per hue would move every dark theme's pill fill, breaking Review Focus 1.
Each site keeps its percentage and surface and only swaps the hue it mixes: `--green-solid` / `--amber-solid` for green and amber, the bare token for mustard
and cyan. `#8a5214` is the darkest-needed ink: the dashboard's `#945917` measures 4.30:1 over the 12 % `--steel` site.
| `--ink2` / `--ink3` | secondary / tertiary text | unchanged | `#525252` / `#6b6b6b` |

`--red` (#b03b28, 5.35:1 on `--strip-hi`) already passes and stays. `--fill-live` / `--fill-progress` / `--on-fill` stay as they are; `--green-solid` happens
to equal `--fill-progress` in Daylight — leave both, they answer different questions.

Classifying each `styles.css` use: `color:` on type → the text token (`--amber-text` for amber); a solid `background`, `border-color`, `box-shadow`, `stroke`/`fill`
or meter/bar fill → the `-solid` token (green, amber) or the bare token (mustard, cyan — dark enough to be a mark); a tint site as described above, with
`--amber-ink` on amber text over it. Aliases count: `--good: var(--green)` feeds `.run-stepper-dot-filled`'s background (`styles.css:1256`) — classify each
alias by what its readers draw. After the pass, `client/src/styles.css` names bare `var(--amber)` nowhere.

- [ ] **Step 1: Write the failing test** — `test/daylight-contrast.test.ts`, parsing `shared/theme.css` (and `client/src/styles.css` for the last two), WCAG
  relative luminance, `color-mix(in srgb, X N%, transparent)` composited over the surface before measuring. Cases:
  - each of `--ink --ink2 --ink3 --green --mustard --cyan --red --magenta --amber-text` ≥ 4.5 on each of `--strip --strip-hi --board --steel` in Daylight;
  - **tint pairs read from the stylesheet:** for every rule in `client/src/styles.css` whose `background` is `color-mix(in srgb, var(--X…) N%, var(--S))`
    and whose `color` is a status token, that text ≥ 4.5 over the composite of the Daylight value at N % on the Daylight `--S` — the percentage and surface
    each site actually uses, not a list in the test (today's worst: amber 12 % on `--steel`);
  - `--amber-solid` ≥ 3.0 on `--strip --strip-hi --board` (WCAG 1.4.11 mark);
  - **dark blocks derive:** every token in the table is declared either in each of the four dark blocks or in a `:root` block whose value is `var(--…)` /
    `color-mix(… var(--…) …)` — never a hex — so a dark theme cannot pick up a Daylight literal;
  - **defaults precede daylight:** the `:root` block declaring `--green-solid` starts before `[data-theme="daylight"]{` in `shared/theme.css`;
  - **tint sites unchanged in the dark:** each of the ten tint sites keeps its pre-task percentage and surface (pin the ten `N%, var(--S)` pairs);
  - `client/src/styles.css` contains zero `var(--amber)` (the bare token).
- [ ] **Step 2:** `pnpm run test:jest -- daylight-contrast` → FAIL (tokens absent; today's values fail the ratios).
- [ ] **Step 3:** Add the defaults block and the Daylight values; rewrite the daylight block's comment (it currently says `--green` maps to a darkened shade
  and `--amber`/`--mustard` take "darkened cousins" — say what is true after this task, and why marks and text now part ways).
- [ ] **Step 4:** Reclassify every use in `client/src/styles.css` per the rule above. Keep a list of the `--amber-text` sites for Review Focus 5.
- [ ] **Step 5:** Update `DAYLIGHT` in `test/design-guards.test.ts` to the new values, and its "§2.2" wording if §8.2 is now the source; update DESIGN.md §8.2.
- [ ] **Step 6:** `pnpm test`, `pnpm run typecheck` → green.
- [ ] **Step 7: Commit** `fix(theme): daylight status tokens that hold AA, marks split from text`.

### Task 2: One `Chevron` for every disclosure mark

**Files:**
- Create: `client/src/components/ui/Chevron.tsx` (header comment cites its DESIGN.md subsection)
- Modify: `client/src/components/TrackerChip.tsx:82-84` (`.tracker-caret` ▾), `client/src/components/board/DispatchButton.tsx:304-306` (`.dispatch-mark` ▸)
- Modify: `client/src/styles.css` (`.chev` rules; drop any font-size that only sized the glyph)
- Create: `test/chevrons.test.ts`

**Interfaces — produces:** default export `Chevron({ dir?: 'down' | 'up' | 'right'; className?: string })` → an inline SVG (10×10 viewBox, one stroked
`M2 4l3 3 3-3` path), `aria-hidden="true"`, class `chev chev-<dir>` plus `className`. `.chev` draws it in an **11×11 px** box (the dashboard's is 9×9; the
board's caret is 11 px per `.claude/DESIGN.md:186`, which this task updates to name the component). Remove the `[aria-expanded="true"] .tracker-caret`
rotate (`styles.css:335`), or an `up` chevron turns back down. Colour is `currentColor`; `up`/`right` are rotations of the one path, with
a 160 ms transform transition that `prefers-reduced-motion: reduce` turns off.

TrackerChip's caret points `up` while its popover is open and `down` otherwise; DispatchButton's mark is `right`.

- [ ] **Step 1: Write the failing test** — cases:
  - no `.tsx` under `client/src/components/` contains any of `▸ ▾ ▴ ◂ ▶ ▼` outside comments (strip comments first, as the dashboard's test does; failure
    names the file);
  - no `content:` declaration in `client/src/styles.css` contains one of them;
  - rendered `Chevron dir="right"` (jsdom) is an `svg` with `aria-hidden="true"` and classes `chev` and `chev-right`; default `dir` gives `chev-down`;
  - `className="x"` is appended, not substituted.
- [ ] **Step 2:** run → FAIL (two glyph sites, no component).
- [ ] **Step 3:** implement, replace both sites, move sizing to `.chev`.
- [ ] **Step 4:** `pnpm test`, typecheck → green. Eyeball both sites in the running app (Task 5 covers the screenshots).
- [ ] **Step 5: Commit** `fix(ui): one readable chevron in place of the text triangles`.

### Task 3: Daylight is the default theme, listed first

**Files:**
- Modify: `client/src/lib/settings.ts` (`THEMES` order, `DEFAULT_SETTINGS.theme`)
- Modify: `client/index.html` (pre-paint script: stamp `data-theme="daylight"` before the `try`, so a fresh browser, a corrupt blob or blocked storage paints
  Daylight with no dark flash; a stored theme then overrides; rewrite the comment to say so and name the test that pins the literal)
- Modify: `server/src/security.ts` (`THEME_SCRIPT_SHA256` — recompute from the new script bytes; `test/csp.test.ts` already recomputes and will be red until it follows)
- Modify: `client/src/lib/settings.ts:24` — Daylight's label and hint follow the dashboard (`Daylight` / `the reference light board — warm grey, white cards,
  green ramp`); `test/settings-view.test.tsx:104` clicks `/Daylight Strip/` and must follow
- Test: `test/settings.test.ts` (the new cases below); `docs/subsystems/board.md` never names a default theme, so no doc edit here
- Hoist `var r = document.documentElement` above the `try`, as the dashboard did, so the stamp can use it

`shared/theme.css`'s `:root` block stays Midnight — only the stamp and the default move.

- [ ] **Step 1: Write the failing tests** — cases:
  - `DEFAULT_SETTINGS.theme === 'daylight'`;
  - `THEMES[0].id === 'daylight'`, and the other four keep their current relative order;
  - the first `dataset.theme = '<x>'` in `client/index.html`'s inline script sits outside the `try` and `<x>` equals `DEFAULT_SETTINGS.theme`;
  - `clampSettings` of a blob with no `theme` → `daylight`; of `{ theme: 'midnight' }` → `midnight`; of `{ theme: 'bogus' }` → `daylight`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement; update the hash; `pnpm run test:jest -- csp` → green.
- [ ] **Step 4:** `pnpm test`, typecheck, `pnpm run build` → green.
- [ ] **Step 5: Commit** `feat(settings): Daylight is the default theme and listed first`.

### Task 4: Prompt-cursor wordmark

The rail's `Dot` + "Backlog / Manager" becomes a `BACKLOG` kicker over `› manager▌` in the one UI face (DESIGN.md §1 — no mono). The cursor blinks while a
run on this machine is working, stands solid otherwise, and holds still under reduced motion.

**Files:**
- Create: `client/src/lib/runPulse.ts` (or the existing run-derivation home in `lib/` if one fits — one home per derivation)
- Modify: `client/src/components/SideRail.tsx` (`brand`), `client/src/App.tsx` (holds the `working` boolean, passes it to `SideRail`)
- Modify: `BoardView.tsx`, `RunsView.tsx`, `ArchiveView.tsx` — each already calls `useOrchestratorRuns()`; each reports `working` up through one callback prop.
  Do **not** add a fourth `useOrchestratorRuns()` call in `App`: every call is its own 5 s poller.
- Modify: `client/src/styles.css` (`.rail-brand`, `.rail-kicker`, new `.rail-prompt`/`.rail-caret`/`.rail-cursor`, the <700 px bar variant at ~l.298; remove
  `.rail-word`)
- Modify: `.claude/DESIGN.md` §8.0 (the wordmark paragraph, ~l.174, and the "wordmark's dot" phrase in `SideRail`'s doc comment)
- Test: a jsdom suite for `SideRail` (extend the existing one if there is one) and a unit test for the derivation

**Interfaces — produces:** `runsWorking(runs, starting): boolean` — no clock: true when any `starting` entry exists, or any local run has
`status === 'running'` and `!isCrashed(run)` (`client/src/lib/run-watchdog.ts:83`, which reads the server-computed `run.fresh`; do not write a second
freshness check). `remote` runs do not count: they are another machine's work. `SideRail` gains `working?: boolean`; undefined (Settings, or before the first
poll) reads as not working. `App` resets its `working` to `undefined` on every section change, so a value reported by an unmounted view never outlives it.

Geometry from the dashboard: kicker 11/400, uppercase, `.16em` tracking, `--ink3`; prompt 22/600, `-.03em`, caret and cursor 8 px gap; cursor 10×22, 1 px
radius, `--green-solid`, and the `›` caret in `--green-solid` too; blink `steps(1)` over 1.06 s; bar variant: prompt 17 px, gap 6, cursor 8×17, kicker
**11 px** — the dashboard's 10 px would fail design guard 3 (`test/design-guards.test.ts:179`, 11 px floor); keep the guard, log the deviation in the
rulings file. The `<h1>` carries
`aria-label="Backlog Manager"` and its visible parts are `aria-hidden`.

- [ ] **Step 1: Write the failing tests** — cases:
  - `runsWorking`: empty → false; one `running` run with `fresh: true` → true; a `running` run with `fresh: false` (crashed) → false; a `paused` run → false;
    one `starting` entry and no runs → true; only a `remote` run → false;
  - App: Board reports `working: true`, then the section switches to Settings → the cursor has no `blink`;
  - `SideRail working` → cursor has `blink`; `working={false}` and omitted → cursor without `blink`;
  - exactly one `h1` in the document at desktop width, accessible name `Backlog Manager`;
  - reduced motion stops the blink: add `.rail-cursor.blink` to the table `test/motion-style.test.ts` already drives every `animation: none` override from
    (`.claude/DESIGN.md:405`), rather than a separate assertion.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement; wire the three views; update DESIGN.md §8.0.
- [ ] **Step 4:** `pnpm test`, typecheck → green.
- [ ] **Step 5: Commit** `feat(rail): prompt-cursor wordmark that blinks while a run works`.

### Task 5: Look at it, then record

- [ ] Headless Playwright from the npx cache (memory `ui-mockups` §Live-app layout checks), against a Vite on a spare port proxying to the stack's API, at
  1280×900 and 375×812 in **daylight**: Board (a pill, a meter, the tracker chip open and closed, a dispatch button), Runs, the rail/bar wordmark. Then one
  1280 shot in **midnight** of the same Board to compare against `main` — it must look identical apart from the chevrons and the wordmark.
- [ ] Kill only the pid you started.
- [ ] `docs/subsystems/board.md`: the default theme, the wordmark, the chevron — wherever it describes them.
- [ ] `docs/superpowers/decisions/2026-10-14-dashboard-redesign-ports-rulings.md`: every ruling made along the way, each with what it costs if wrong — at least
  the remote-runs exclusion, the `--amber-text` = ink choice and any `--amber-ink` exceptions from Review Focus 5.
- [ ] Final `pnpm test`, `pnpm run typecheck`, `pnpm run build`.
