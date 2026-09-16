# Settings → Local / Shared pages, and a content-width setting

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port two patterns from `../claude-agents-dashboard` into this client — Settings split into **Local** and **Shared** pages picked from the rail's sub-nav
tree, and a `contentWidth` setting that releases the page's measure so the board can span the window.

**Architecture:** Both features are two new flat keys on the existing per-device settings object. `contentWidth` is stamped as `data-width` on `<html>` (pre-paint,
beside theme and density) so one CSS block drops the `.wrap` cap with no component re-rendering. `settingsScope` lives in the settings object rather than in a
module-level store like `useRunsMode`, because `SettingsProvider` is a React context and both readers — the rail and `SettingsView` — already sit inside it. The
rail's hardcoded Runs tree generalises to one render path with two call sites. No server behaviour changes; the only server file touched is the CSP hash constant,
which the pre-paint edit invalidates.

**Tech stack:** React 18 + TypeScript, Vite, plain CSS with theme tokens, jest + `@testing-library/react` (jsdom via docblock), NestJS on the server side.

**Spec:** none. This plan carries the design; it was agreed in chat rather than written to `docs/superpowers/specs/`, on the grounds that the whole change is two
settings keys, one card split and one rail generalisation. Everything an executor needs is below.

## Global constraints

- **This plan states behaviour and exact test *cases*. It deliberately does NOT hand you literal code, and that overrides the writing-plans template's "code blocks
  required".** Handed code gets transcribed verbatim, so a defect in the plan becomes a defect on the branch with nobody positioned to catch it. Expected values,
  names and signatures below are exact and binding; how you satisfy them is yours, and if a case looks wrong, say so rather than implementing it.
- **Comments explain _why_, at length.** The existing density in `client/src/` is deliberate — match it. Every component cites its `.claude/DESIGN.md` subsection in
  a header comment.
- **Wrap new prose and comments at 160 columns.** Never reflow existing text to widen it.
- **No literal colours in `client/src/styles.css`** — tokens only. `test/design-guards.test.ts` guard 3 also forbids any `px` font-size under 11px.
- **`pnpm test` is the union of both runners** (`scripts/test-all.mjs`). `pnpm typecheck` must also print green. Both are required before each commit below.
- **Settings stay flat.** `usePersistedState` shallow-merges a stored value over the defaults, one level deep, so a nested object written by an older release would
  never gain a new inner field's default.
- Target ≤ 5 tasks and ~400 lines of new client code — a **soft** budget, not a rule. If a load-bearing comment or case makes it longer, it gets longer.

---

### Task 1: Two new settings keys

**Files:**
- Modify: `client/src/lib/settings.ts`
- Test: `test/settings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type SettingsScope = 'local' | 'shared'`; `type ContentWidth = 'fixed' | 'full'`; `SETTINGS_SCOPES: readonly SettingsScope[]` and
  `CONTENT_WIDTHS: readonly ContentWidth[]` exported as the one home of each member list; `Settings.settingsScope` and `Settings.contentWidth`, both flat, both
  defaulted in `DEFAULT_SETTINGS` (`'local'` / `'fixed'`), both validated in `clampSettings` with the existing `pickOne`.

- [ ] **Step 1: Write the failing cases in `test/settings.test.ts`**

  Eight cases, following the file's existing style:
  1. `DEFAULT_SETTINGS.settingsScope` is `'local'`, and `DEFAULT_SETTINGS.contentWidth` is `'fixed'` — an install that has never opened Settings behaves exactly as
     it does today.
  2. `clampSettings({ settingsScope: 'shared' }).settingsScope` is `'shared'`.
  3. `clampSettings({ settingsScope: 'nonsense' }).settingsScope` is `'local'`; same for `7` and for `null`.
  4. `clampSettings({ contentWidth: 'full' }).contentWidth` is `'full'`.
  5. `clampSettings({ contentWidth: 'wide' }).contentWidth` is `'fixed'`; same for `1`.
  6. One bad sibling does not discard a good new key: `clampSettings({ theme: 'chartreuse', settingsScope: 'shared', contentWidth: 'full' })` returns
     `theme: 'midnight'` **and** keeps both new values.
  7. `clampSettings({})` returns both defaults — a settings blob written before either key existed still loads.
  8. `SETTINGS_SCOPES` and `CONTENT_WIDTHS` each hold exactly their two members, asserted literally. These are the lists the pickers and the validator both derive
     from; a test that asserts them is what stops a third member being added in one place only.

- [ ] **Step 2: Run them and watch them fail**

  ```bash
  pnpm run test:jest -- test/settings.test.ts
  ```

  Expected: TypeScript errors on the unknown properties, or assertion failures on `undefined`.

- [ ] **Step 3: Add the two keys**

  Both fields carry a comment in the file's existing register, answering *why per-device*:
  - `settingsScope` — which Settings page is showing. Per device because it is a view position, not a preference about the work: the laptop left on the Shared page
    and the phone opening on Local cost nothing.
  - `contentWidth` — `fixed` keeps the drawn measure (820px, or 1280px for `.wrap.wide`); `full` drops the cap so a section spans the window. Per device for the
    plainest possible reason: the measure that reads well is a property of the screen in front of you.

- [ ] **Step 4: Green**

  ```bash
  pnpm run test:jest -- test/settings.test.ts && pnpm run typecheck
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add client/src/lib/settings.ts test/settings.test.ts && git commit -m "feat(settings): add settingsScope and contentWidth keys"
  ```

---

### Task 2: Content width — stamp, CSS, row, and the CSP hash it invalidates

**Files:**
- Modify: `client/src/hooks/useSettings.tsx` (the stamping effect)
- Modify: `client/index.html` (the pre-paint script)
- Modify: `server/src/security.ts:20` (`THEME_SCRIPT_SHA256`)
- Modify: `client/src/styles.css` (one block beside the `.wrap` rules at line 106)
- Modify: `client/src/components/settings/SettingsView.tsx` (one row in the Display card)
- Test: `test/settings-view.test.tsx`, `test/csp.test.ts` (already guards the hash — no new case), new `test/content-width-style.test.ts`

**Interfaces:**
- Consumes: `ContentWidth`, `CONTENT_WIDTHS`, `Settings.contentWidth` from Task 1.
- Produces: `data-width="fixed" | "full"` on `document.documentElement`, stamped both pre-paint and by `useSettings`.

- [ ] **Step 1: Write the failing cases**

  In `test/settings-view.test.tsx`, inside the existing `describe('SettingsView', …)`:
  1. The Display card offers a **Content width** control with two options labelled `Fixed` and `Full`, starting on `Fixed`.
  2. Clicking `Full` persists `contentWidth: 'full'` under `backlog-manager.settings` — assert by reading and parsing the stored key, the way the theme case
     already does.
  3. After that click, `document.documentElement.dataset.width` is `'full'`. This is the case that proves the effect and the setting are wired to each other and
     not merely both present.

  In a new `test/content-width-style.test.ts` (a source guard, in the idiom of `test/live-bar-style.test.ts` — it reads files, it does not render):
  4. `client/src/styles.css` contains a rule selecting `:root[data-width="full"] .wrap` **and** `:root[data-width="full"] .wrap.wide`, whose body sets
     `max-width: none`. Behaviour cannot catch this — jsdom applies no stylesheet — and the failure mode is a setting that silently does nothing.
  5. `client/index.html`'s single inline script mentions `contentWidth` and assigns `dataset.width`. Same reasoning: the pre-paint stamp is the half no test can
     observe at runtime, and without it a `full` install visibly snaps out of the fixed measure on every load.

- [ ] **Step 2: Run them and watch them fail**

  ```bash
  pnpm run test:jest -- test/settings-view.test.tsx test/content-width-style.test.ts
  ```

- [ ] **Step 3: Implement — in this order**

  1. `useSettings.tsx`: stamp `root.dataset.width` beside theme and density, and add `settings.contentWidth` to the effect's dependency list. A stamp missing from
     the deps is the classic version of this bug: it works on reload and not on the click.
  2. `client/index.html`: one line in the pre-paint script, mirroring the theme/density lines and failing silently the same way.
  3. `styles.css`, next to `.wrap` at line 106, with a comment saying what `full` means and that it is stamped pre-paint. Both `.wrap` and `.wrap.wide` are released
     — after Task 4 Settings itself renders in the wide wrap, so releasing only the narrow one would leave Settings capped in fullscreen.
  4. `SettingsView.tsx`: a `SettingsRow` in the Display card, under **Text size**, using `Segmented` with `pill` — the same family as Density and Text size. Labels
     `Fixed` / `Full`; hint says the fixed measure is the drawn one and that `Full` lets every section span the window.

- [ ] **Step 4: Recompute the CSP hash — this step is not optional**

  Editing the inline script changes its bytes, and `server/src/security.ts` pins their sha256. Skipping this ships a served build whose theme script the browser
  refuses to run: the page paints in the default palette at 100% on every load, and nothing in dev shows it, because dev has no CSP.

  ```bash
  node -e "const{readFileSync}=require('fs'),{createHash}=require('crypto');const m=[...readFileSync('client/index.html','utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)];console.log('sha256-'+createHash('sha256').update(m[0][1],'utf8').digest('base64'))"
  ```

  Paste the printed value into `THEME_SCRIPT_SHA256` (`server/src/security.ts:20`). `test/csp.test.ts`'s "covers the pre-paint theme script's exact bytes" case
  recomputes the same hash from the same file, so it is the proof this was done — do not edit that test.

- [ ] **Step 5: Green**

  ```bash
  pnpm test && pnpm run typecheck
  ```

  Expected: green, `test/csp.test.ts` included.

- [ ] **Step 6: Commit**

  ```bash
  git add client/index.html client/src/hooks/useSettings.tsx client/src/styles.css client/src/components/settings/SettingsView.tsx server/src/security.ts test/
  git commit -m "feat(settings): content width, stamped pre-paint like theme"
  ```

---

### Task 3: One sub-nav render path, two sections

**Files:**
- Modify: `client/src/components/SideRail.tsx:118-141` (the `t.id === 'runs' && treeOpen('runs')` block) and `:208-224` (`RAIL_SUB_LABEL`)
- Test: `test/rail.test.tsx`

**Interfaces:**
- Consumes: `settingsScope` / `SETTINGS_SCOPES` (Task 1), `useSettings` (already imported by the shell, new to the rail), the existing `useRunsMode`.
- Produces: no new export. The rail writes `settingsScope` through `useSettings().update` and reads it from `useSettings().settings`.

**Why one path rather than two blocks:** the tree's markup carries three details that must not drift — the `rail-sub` / `rail-sublink` classes, `aria-current="true"`
(deliberately not `"page"`, which the section row above holds), and closing the phone menu on a pick. Copied for a second section, they become two things free to
disagree. What legitimately differs per section is only the item list, which value is current, and what a click does — so that is what the call sites supply.

- [ ] **Step 1: Write the failing cases in `test/rail.test.tsx`**

  1. With `section="settings"`, the rail renders a group labelled `Settings pages` holding exactly two entries, `Local` and `Shared`.
  2. With `section="board"`, no Settings tree is rendered — same rule the Runs tree already follows.
  3. `Local` carries `aria-current="true"` by default (`settingsScope` defaults to `'local'`); after clicking `Shared`, `Shared` carries it and `Local` does not.
  4. Clicking `Shared` persists `settingsScope: 'shared'` under `backlog-manager.settings`, and calls the rail's `onChange` with `'settings'` — the same pair the
     Runs entries make, so clicking a page from another section both switches section and selects the page.
  5. The Runs tree still renders `History` and `Watchdog` while `section="runs"`, still writes `backlog-manager.runs-mode`, and still renders nothing while
     `section="settings"`. Regression cover for the generalisation — these cases exist today and must keep passing unchanged.
  6. Below 700px (the file's existing narrow-mode helper) both trees stand open when their section is current, exactly as Runs does now.

- [ ] **Step 2: Run them and watch them fail**

  ```bash
  pnpm run test:jest -- test/rail.test.tsx
  ```

- [ ] **Step 3: Generalise the tree**

  The rail must be rendered inside `SettingsProvider` for `useSettings` to work. It already is — `App` wraps `AppShell`, which renders `SideRail` — but
  `test/rail.test.tsx` renders the rail directly, so its cases need the provider wrapper `test/settings-view.test.tsx` already uses. Follow that file's pattern
  rather than inventing a second one.

  Labels are **Local** and **Shared**, and they are the only labels these two pages have — there is no in-page switch to disagree with them (see Task 4).

- [ ] **Step 4: Green**

  ```bash
  pnpm run test:jest -- test/rail.test.tsx test/nav.test.tsx && pnpm run typecheck
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add client/src/components/SideRail.tsx test/rail.test.tsx && git commit -m "feat(rail): sub-nav tree serves Runs and Settings from one path"
  ```

---

### Task 4: Settings becomes two pages

**Files:**
- Modify: `client/src/components/settings/SettingsView.tsx`
- Modify: `client/src/App.tsx:96` (the `section === 'settings' ? 'wrap' : 'wrap wide'` expression)
- Modify: `client/src/styles.css` if the band's right slot needs anything (expected: nothing — `Pill` and `.ui-band-right` already exist)
- Test: `test/settings-view.test.tsx`, `test/nav.test.tsx`

**Interfaces:**
- Consumes: `settings.settingsScope` (Task 1), the rail's writes (Task 3), the existing `Band`, `Pill`, `SettingsGroup`, `SettingsRow`, `WatchdogGroup`.
- Produces: no new export. `SettingsView`'s props are unchanged — it still takes `onOpenWatchdog`.

**Page membership:**

| Page       | Column 1                        | Column 2                                               |
| ---------- | ------------------------------- | ------------------------------------------------------ |
| **Local**  | Display, Board                  | Orchestrator, **Dispatch** (new)                       |
| **Shared** | Orchestrator watchdog           | Claude Agents                                          |

**The Claude Agents split.** Today that card mixes backends: its status lines and `Setting it up` block report the host's own environment, while `Default model`,
`Default effort` and `Dashboard link` are this browser's `localStorage`. The whole promise of the split is that the page *is* the scope, so the card divides:

- New Local card **Dispatch**, `scope="this device"` — `Default model`, `Default effort`, `Dashboard link`, and the `open dashboard ↗` link, which moves onto the
  `Dashboard link` row it reads its value from. A link driven by a per-device value has no business on the Shared page, and beside the field that sets it the link
  also becomes self-explaining.
- **Claude Agents** keeps `scope="this machine"` on the Shared page, carrying the `Dispatch` status row (now with no control in its right slot) and the conditional
  `Setting it up` block.

**The scope pill.** `Band`'s existing `children` right slot, holding one `Pill`. Both pages use `tone="neutral"` and the word carries the distinction — `this
browser` on Local, `this machine` on Shared. Deliberately NOT the dashboard's green-tinted Shared pill: `PillTone`'s five members each name a *reading* (`live`,
`warn`, `bad`, `done`, `neutral`) rather than a colour, none of them means "shared", and minting a second pill look in the settings block would be a second home for
a primitive — which `test/design-guards.test.ts` guard 7 exists to refuse.

**The band's subtitle** changes per page, since the one-line summary is now the page's own: Local says these are this browser's and never leave it; Shared says the
API reads these, so every device sees the same values.

**No phone pill.** The dashboard shows a pill switch in the band below 700px; this board does not, because the rail's trees stand open at that width and Runs
already establishes that a sub-view has exactly one control at any width. A second control here would be a second wording free to disagree with the tree's.

- [ ] **Step 1: Write the failing cases in `test/settings-view.test.tsx`**

  Membership, both ways — these are the cases that make the split real:
  1. With `settingsScope: 'local'` stored, the page renders the `Display`, `Board`, `Orchestrator` and `Dispatch` card titles, and renders neither
     `Orchestrator watchdog` nor `Claude Agents`.
  2. With `'shared'` stored, the inverse: `Orchestrator watchdog` and `Claude Agents` are present, the four Local titles are absent.
  3. The band's pill reads `this browser` on Local and `this machine` on Shared.
  4. Neither page renders any control that changes `settingsScope` — assert no element named `Local` or `Shared` exists inside the rendered view. This is the phone
     pill's absence, pinned, because it is the detail a later "improvement" would reintroduce.

  The card split:
  5. On Local, `Default model`, `Default effort` and `Dashboard link` are present, and `open dashboard ↗` is present.
  6. On Shared, none of those four are present, and the `Dispatch` status row is.
  7. The existing `Claude Agents` cases — healthy report, setup steps hidden before the first answer, setup steps shown when dispatch is off — keep passing, moved
     under a `'shared'` stored scope. The existing link-editing and default-picker cases move under `'local'`. Move them; do not rewrite what they assert.
  8. `Orchestrator` still renders above `Orchestrator watchdog` in DOM order — **this case must now be deleted or restated**. The two cards are on different pages,
     so "renders above" is no longer a thing either page can be asked. Restate it as: on Local the `Orchestrator` card is present, and its two rows (`Default merge
     mode`, `Default question mode`) are in it rather than in `Dispatch`. The adjacency the old case protected is gone by design, and a test asserting a layout the
     design deliberately dropped is worse than no test.

  In `test/nav.test.tsx`:
  9. The Settings section renders inside `wrap wide`, like every other section. (If no case currently asserts the wrap class, add one for all four sections rather
     than for Settings alone — a single-section assertion is the shape that goes stale.)

- [ ] **Step 2: Run them and watch them fail**

  ```bash
  pnpm run test:jest -- test/settings-view.test.tsx test/nav.test.tsx
  ```

- [ ] **Step 3: Implement**

  `SettingsView` reads `settings.settingsScope` and renders the band plus one of two `set-cols` layouts. The cards themselves are unchanged apart from the Agents
  split — rows, hooks, warnings and handlers all move as they are. `App.tsx` drops the ternary: every section now renders in `wrap wide`.

  Keep the existing comment on `set-cols` explaining why the columns are hand-balanced rather than reflowed, and extend it to say what each page's balance is: Local
  is two short cards against two taller ones, Shared is the watchdog's long card against the agents report.

- [ ] **Step 4: Green**

  ```bash
  pnpm test && pnpm run typecheck
  ```

- [ ] **Step 5: See it**

  ```bash
  pnpm run dev:web
  ```

  Check, at 1400px and at 390px, in both the `daylight` and `midnight` themes: both pages; the rail tree showing Local/Shared only while Settings is open and both
  trees standing open on the phone; `Content width: Full` releasing the measure on Board, Runs, Archive **and** Settings; a reload on `full` painting full-width
  with no snap. Kill the dev server by the pid you started it with — never by pattern.

- [ ] **Step 6: Commit**

  ```bash
  git add client/src/components/settings/SettingsView.tsx client/src/App.tsx client/src/styles.css test/
  git commit -m "feat(settings): split into Local and Shared pages"
  ```

---

### Task 5: Docs, invariants and the rules pointer

**Files:**
- Modify: `docs/subsystems/invariants.md` (two new anchors)
- Modify: `CLAUDE.md` (two new Invariants bullets, one line each, each linking its anchor)
- Modify: `docs/subsystems/board.md` (`### The rail` at line 13, `### Settings` at line 169, and the `## Invariants` list at line 194)
- Modify: `.claude/DESIGN.md` §8.6
- Modify: `.claude/rules/board.md` (one pointer line per new anchor)
- Test: `test/claude-rules.test.ts` and `test/dialog-count-docs.test.ts` already run over these files — no new test.

**The two invariants, stated:**

1. **Settings is two pages, the page is the scope, and the rail is the only thing that switches them.** `settingsScope` (`client/src/lib/settings.ts`) is
   `local | shared`; Local is everything in this browser's `localStorage`, Shared is what the API reads from the host — the watchdog's settings file and the
   environment the server was started with. No card mixes the two, which is why `Claude Agents` is two cards and why `open dashboard ↗` sits beside the
   per-device field that supplies its href. There is no in-page switch at any width, the same rule Runs' two pages follow.
2. **`contentWidth` is stamped before first paint, and the CSP hash travels with the script that stamps it.** `data-width` on `<html>`, written twice — by
   `client/index.html`'s inline script and by `useSettings` — because a stamp applied only at mount makes a `full` install snap out of the fixed measure on every
   load. Editing that script invalidates `THEME_SCRIPT_SHA256` (`server/src/security.ts`); `test/csp.test.ts` recomputes the hash from the file and is the guard.
   Dev has no CSP, so this failure is invisible until the built app is served.

- [ ] **Step 1: Write the reasoning in `docs/subsystems/invariants.md`**

  Full sections, in the file's register — what the rule is, what failure it encodes, what a reader would otherwise be tempted to do. Anchors:
  `#settings-is-two-pages-the-page-is-the-scope` and `#contentwidth-is-stamped-before-first-paint-and-the-csp-hash-travels-with-it`.

- [ ] **Step 2: One line each in `CLAUDE.md`'s Invariants list, and one pointer each in `.claude/rules/board.md`**

  Both files are one line per rule and nothing else — the reasoning has one home and it is not either of them.

- [ ] **Step 3: Update `docs/subsystems/board.md`**

  `### The rail` gains the sub-nav serving two sections. `### Settings` is rewritten for the two pages, the card membership table above, and the Agents split.
  `## Invariants` gains the two entries.

- [ ] **Step 4: `.claude/DESIGN.md` §8.6**

  One paragraph: the Settings band carries a scope pill in its right slot, both pages draw the same two-column card layout, and the scope pill is the existing
  `Pill` primitive at `neutral` — not a new look — with the reason.

- [ ] **Step 5: Green, then commit**

  ```bash
  pnpm test && pnpm run typecheck
  git add CLAUDE.md docs/ .claude/ && git commit -m "docs: settings pages and the content-width stamp"
  ```

---

## Verification before finishing

- [ ] `pnpm test` — both runners, green.
- [ ] `pnpm run typecheck` — green.
- [ ] `grep -nE "#[0-9a-f]{3,6}" client/src/styles.css` over the settings block returns nothing new.
- [ ] A settings blob from before this branch (delete the two new keys from `backlog-manager.settings` in devtools and reload) opens on Local at the fixed measure.

## Not in scope

- Any server behaviour change. `THEME_SCRIPT_SHA256` is a constant, not behaviour.
- Re-skinning other sections' cards, or changing what any existing setting does.
- Per-grid layout rules for `full` — every existing grid stretches. The board's four columns are the four item types and stay four.
- A third settings page, or moving any setting between backends.
