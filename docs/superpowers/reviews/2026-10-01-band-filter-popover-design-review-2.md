# Review 2 — `docs/superpowers/specs/2026-10-01-band-filter-popover-design.md`

Date: 2026-10-02. Reviewer: a fresh Fable session, handed only the spec path and the checklist. Every claim below was checked against the code named;
`<doc>:<line>` is the spec, every other `file:line` is the repo (or the dashboard, where `../claude-agents-dashboard/` is spelled out). Review 1's seven
Important findings and its Critical are all addressed in this draft and were not re-raised.

## Verdict: REVISE

One Critical: the phone rule the spec now carries for `.ui-popover` — review 1's C1 fix — is written as a media-query override on the bare family selector,
and guard 7 counts that selector twice, so `pnpm test` goes red the moment the rule lands; the tracker phone guard the spec rewrites in §4 demands exactly that
bare selector, so the two tests the spec names pull in opposite directions. The board's own two overlays solved this months ago with a `useNarrow` modifier,
which is the fix. Four Important findings, all "an implementer must guess or a value is wrong": a count-line test value that the exact-match assertion will
fail, a panel edge that §1 and §2 place differently, a `z-index` the paint list drops that Archive's sticky kickers will paint over, and an Archive hint that
names a control Archive does not have.

## Critical

### C1 — `<doc>:36-39` with `<doc>:178` and `<doc>:173-174`: the 700 px override on bare `.ui-popover` turns guard 7 red, and the phone guard the spec rewrites requires exactly that selector

§1 moves the phone rule "onto `.ui-popover`" — a second `.ui-popover { … }` inside a `@media (max-width: 700px)` block — and §4 says guard 7's `FAMILIES`
gains `.ui-popover`, "declared once inside the primitives block".

- `test/design-guards.test.ts:43-52` — `rules()` is `/([^{}]*)\{([^{}]*)\}/g` over the comment-blanked sheet. A rule nested in a media block is flattened
  to its own selector: the regex cannot match `@media … { .x {`, advances, and matches `.ui-popover { … }` with selector `.ui-popover`. Checked on the real
  sheet: `.tracker-pop` parses to **2** rules (base + its 700 px override), `.ui-figure-strip` to 2, `.ui-modal` and `.ui-form-sheet` to 1.
- `test/design-guards.test.ts:352-357` — `bare = styleRules.filter((r) => r.selector === family)`, `count` must equal `1`. With the spec's base rule and
  its 700 px rule both present, `.ui-popover` counts 2 and the guard fails.
- No family in the block has a media override today, and the two that change shape on a phone do it the other way: `client/src/components/ui/Modal.tsx:45,54`
  and `ui/FormSheet.tsx:57,67` read `useNarrow()` and add `ui-modal-narrow` / `ui-form-sheet-narrow` — `styles.css:2846`, `:2890` — a modifier declared
  once. `test/ui-modal.test.tsx:52` pins it by name: "takes the full-screen shape from useNarrow, not from a media query of its own".
- `<doc>:173-174` then rewrites `test/tracker-chip.test.tsx:144-156` to read `.ui-popover` inside the 700 px block — regex `/\.ui-popover \{([^}]*)\}/`
  over the joined `@media (max-width: 700px)` bodies (`:148-149`). That assertion is satisfiable only by the bare selector guard 7 forbids. Written as the
  spec says, one of the two suites is red whichever way the CSS goes.

**Fix:** `Popover` reads `useNarrow()` and renders `ui-popover ui-popover-narrow` below 700 px, the modifier carrying the eight declarations §1 lists
(`position: fixed; top: auto; margin-top: 8px; left: 12px; right: 12px; width: auto; max-height: 70vh; overflow-y: auto`), declared once in the primitives
block beside the base rule — the shape `Modal` and `FormSheet` already have. Three bullets change: §1's phone bullet (a modifier, not a media rule); §4's
`ui/Popover` suite gains "takes the phone shape from `useNarrow`" asserting the class under a stubbed `matchMedia` (the `ui-modal.test.tsx:47-62` recipe);
§4's tracker phone-guard bullet becomes a source assertion on `.ui-popover-narrow`'s declarations (same five regexes, no media block) or is retired in
favour of the `Popover` case. §5 then also touches `useNarrow.ts:7-14`'s list of what reads the breakpoint, and `docs/subsystems/board.md:36-40`'s
"declared once" sentence stays true.

## Important

### I1 — `<doc>:159` (and `<doc>:101`): with an unrecognised status and project `all`, the count line reads `0 items across 0 projects`, not `0 items`

- `client/src/components/board/BoardView.tsx:488-492` — `countLine` under `projectValue === ALL` is `` `${visible.length} ${countWord} across ${countProjects} …` ``;
  `countWord` is `COUNT_WORDS[status] ?? 'items'` (`:487`), so a stored `'bogus'` with nothing picked renders `0 items across 0 projects`.
- `<doc>:105-107` states the rule correctly ("With project `all` the line is unchanged"), so the example disagrees with its own rule.
- `test/board.test.tsx:303,306,313` assert the count line with exact-match `getByText(...)`; a case written to the spec's value fails.

**Fix:** write the expected value as `0 items across 0 projects`, or have the case pick a project first and expect `0 items in <name>`.

### I2 — `<doc>:33-34` ("8 px below its button, right-aligned to it") vs `<doc>:62-63, 89`: the panel's right edge is the wrapper's, which for `FilterBar` is the track's

- §2 positions the panel `right: 0` against "the caller's wrapper … `FilterBar`'s own wrapper", and §2 line 89 puts `margin-left: auto` on that same
  wrapper — one element holding the whole track and both popovers.
- That is the dashboard's shape exactly: `../claude-agents-dashboard/client/src/components/Toolbar.tsx:74-151` — one `.ctlwrap` around `.seg.ctl`
  (both buttons, the divider, the label) and both `<Popover>`s; `styles.css:673` `.ctlwrap{position:relative;margin-left:auto}`, `:683`
  `.pop{position:absolute;top:calc(100% + 8px);right:0}`. Both panels there align to the TRACK's right edge — under the sort icon — never to the filter
  button, which sits ~170 px further left once the sort label is drawn.
- §1 says "right-aligned to it [its button]". An implementer reading §1 wraps each button in its own relative element; one reading §2 wraps the track.
  The two drawings differ by the width of the sort label plus two icons.

**Fix:** say "right-aligned to the track (the `FilterBar` wrapper, as the dashboard's `.ctlwrap`)" in §1, or specify a per-button relative wrapper in §2 —
one or the other.

### I3 — `<doc>:32-35, 76-80`: `Popover`'s rule has no `z-index`, and Archive's sticky month kickers paint over a `z-index: auto` panel

- `client/src/styles.css:338-342` — `.tracker-pop` carries `z-index: 20`, and the dashboard's `.pop` (`styles.css:683`) carries `z-index:20` too. The
  spec's paint list (`<doc>:33`) and its "what moves off `.tracker-pop`" list (`<doc>:76-77`: "position, radius, padding and shadow") both drop it.
- `client/src/styles.css:980-981` — `.archive-month { position: sticky; top: 0; z-index: 1 }`; `:149` — the rail is `position: sticky; … z-index: 5`.
  Nothing between the band and the root creates a stacking context (`.main`, `.maincol`, `.wrap`, `.ui-band` — `:117,248,258,2491` — set no `z-index`,
  `transform` or `contain`), so a positioned panel with `z-index: auto` paints below any later positive-`z-index` box it overlaps: on Archive the filter
  popover drops onto the columns and the month kickers paint through it.

**Fix:** add `z-index: 20` to the `.ui-popover` rule in §1 and name it among what leaves `.tracker-pop` in §2.

### I4 — `<doc>:40-41` with `<doc>:165-166`: the Project hint names Orchestrate on a page that has no Orchestrate

- §1 gives the Project section the hint `· one at a time — Orchestrate needs one`. §2 makes the filter popover's content "the caller's sections", and §4
  says Archive's popover "has Project only".
- `client/src/components/archive/ArchiveView.tsx:229-236` — Archive's band is "search field and the project filter chip — and NOTHING else"; there is no
  Orchestrate control on that page (`:238-271`), and `docs/.claude/DESIGN.md:369` says the same.
- Whether Archive's Project section carries the Board's hint, a different one, or none is unstated, and the Board's reads wrong there.

**Fix:** state Archive's Project section copy — no hint, or a line that does not name Orchestrate — in §1 or §4.

## Minor

- `<doc>:41-42` — the four-way `Segmented` `pill` is content-sized (`styles.css:2740-2766`: `padding: 0 11px`, 1 px borders, 2 px gaps, 3 px track
  padding, 1 px track border): `Open · In progress · Done · All` at 13/500 comes to roughly 270 px against the 268 px content width of a 300 px panel with
  16 px padding. The dashboard's `.sw button` is `flex: 1; padding: 6px 0` for this reason (`:697-698`). Either let `.filter-bar*` lay the switch out full
  width with `flex: 1` buttons, or check the fit in the browser before the plan pins 300 px.
- `<doc>:31` — badge text `--strip`: the board's ink-on-ink text token is `--on-accent` (`.ui-chip-ink`, `styles.css:2562`); DESIGN.md §8.3 (`:247`) says
  `--strip`, so either is defensible — pick one and say which.
- `<doc>:53` — "`.ui-*`, which guard 7 rejects outside the primitives block": the guard rejects only tokens that start with a LISTED family
  (`test/design-guards.test.ts:366-383`); an unlisted `.ui-track` would pass. The conclusion (use `.filter-bar*`) is right; the reason overstated.
- `<doc>:190-191` — `useDialogEscape.ts:71-72`'s ref comment says "the tracker popover", not `TrackerPopover`; only the header (`:30`) names the identifier.
- `<doc>:183-198` — §5 misses four places that name what moves: `client/src/styles.css:374-409` (`.board-filter`, `.board-filter-mark` and the Board-section
  comment "one search field and one filter select, declared once" — dead rules once both selects go); `ArchiveView.tsx:132-137, 149-151, 229-236` (three
  comments naming the select); `BoardView.tsx:742-743` ("the filter is a live `<select>`"); `lib/view-keys.ts:12-15` (names the two keys that stay local — a
  third joins them).
- `<doc>:144` — "carries the raised state": name the hook the test reads (class `on` as the dashboard's `.ictl.on`, or a `data-*`), so the `FilterBar` case
  is writable without guessing.
- `<doc>:103` — "(project ≠ all)": say `projectValue`, the fail-open value (`BoardView.tsx:284-285`), so a stale stored path does not light the badge while
  the `All projects` chip is the pressed one.
- `<doc>:49` — "§12.1's one-home rule": `.claude/DESIGN.md` has no §12 (its headings end at §8.8); `:241` points at "the design spec's §12.1". Cite it as
  that.
- `<doc>:33` — `0 8px 24px var(--shadow2)` is DESIGN.md §5's tooltip lift (`:138`, "Only two things float"); cite it so §8.7's "the design's one shell
  lift" is not read as contradicted.
- `<doc>:86` — Board and Archive each build the Project section's chips from `registered`; two copies of one markup. A shared piece under `board/` (or in
  `FilterBar`, taking `projects` + `value` + `onPick`) keeps one home. Taste.

## Verified true (no finding)

- `<doc>:8` — `f311b1e` is "fix(board): match the dashboard's rail; stop buttons rendering Arial".
- `<doc>:9` — `Toolbar.tsx:74-100`: filter icon with count badge (`.n`), raised while `n > 0` (`.ictl.on` → `.seg>button.on`), `.vsep`, `Sort: <b>key</b>
  (dir)`, sort icon; each opens a `Popover`.
- `<doc>:27` — `.seg{background:var(--hairline2);border-radius:12px;padding:3px}` (`:669`); `.ictl` 34 × 30 (`:674`); svg 18 px, stroke 1.5 (`:675`);
  `.vsep` 1 × 18 `--ink3` opacity .45 (`:679`); `.sortlab` 13 px `--ink2`, `b` `--ink` 500 (`:680-681`).
- `<doc>:30` — `.seg>button.on{background:var(--strip);box-shadow:0 1px 2px var(--shadow)}` (`:672`).
- `<doc>:31` — `.seg .ictl .n`: 16 px, `--ink` on `--strip`, 10 px (`:678`); guard 3's floor is 11 (`test/design-guards.test.ts:193-201`).
- `<doc>:32-35` — `.pop` and `.acct-pop` share `--strip`, 1 px `--hairline`, 12 px radius, `0 8px 24px var(--shadow2)`, 16 px padding, `top: calc(100% + 8px)`,
  `right: 0`; caps `100vw - 48px` and `100vw - 24px` (`:683`, `:430`).
- `<doc>:37-38` — `styles.css:358-363`'s comment and rule are as described; `.rail` on the phone is `overflow-x: hidden; overflow-y: visible` (`:279`).
- `<doc>:45-46` — the dashboard's sort popover has no foot line (`Toolbar.tsx:135-150`); `<doc>:117` — a key pick is `set({ sortKey: k })`, direction
  untouched (`:139`).
- `<doc>:49-51` — `.ui-chip.on { background: var(--strip-hi); border-color: var(--ink3) }` (`:2561`); the dashboard's `.pick.on` fills `--ink` (`:693`).
- `<doc>:52` — density and text size are `Segmented` `pill` (DESIGN.md `:375`); `Dot` takes `hue` (`ui/Dot.tsx:36`).
- `<doc>:62-63` — `.tracker-chip-root { position: relative }` (`:311`).
- `<doc>:66-70, 76-78` — `TrackerChip.tsx:19-22, 39-46, 92, 137-138, 154, 159`: mounted only while open, `useDialogEscape(onClose)`, own `pointerdown`
  listener on `document`, `aria-label="Tracker"`, section change closes (`:37`).
- `<doc>:79-80` — today's shell: radius 16, `0 24px 64px var(--shadow2)`, no border, `padding: 14px 16px`, `top: calc(100% + 6px)` (`:338-342`);
  DESIGN.md §8.0's tracker sentence at `:186`.
- `<doc>:97, 100-102` — `BoardView.tsx:264, 281-285` (fail-open), `:148-166` (the comment, naming "the select sitting right above it").
- `<doc>:108-109` — `BoardView.tsx:721, 747-748` (`projectValue`; `const path = projectValue` captured at click).
- `<doc>:113-116` — `SORT_KEY` (`:35`), `COMPARATORS` (`:109-113`): `created` newest-first, `name`/`project` A→Z, `project` tie-break newest first;
  `?? COMPARATORS.created` (`:167`); `liveRank` primary (`:168`).
- `<doc>:114` — `lib/view-keys.ts:12-15` keeps Board-only keys local.
- `<doc>:133, 148` — `test/board.test.tsx:312-313` (`alpha`, `2 done`); the suites driving the selects are exactly `board`, `board-live-cards`,
  `orchestrator-start-ui`, `tracker-board` (grep over `test/*.tsx`), plus `archive`.
- `<doc>:165` — `test/archive.test.tsx:337` asserts absence with `queryByLabelText('Sort')`.
- `<doc>:169-172` — `test/tracker-chip.test.tsx:261-346` cover the listed behaviours; no suite reads the `tracker-pop` test id or class except the phone guard.
- `<doc>:173-174` — the guard checks five declarations (`:150-155`).
- `<doc>:178` — `FAMILIES` entries carry the leading dot (`test/design-guards.test.ts:314-331`).
- `<doc>:179-180` — `test/dialog-count-docs.test.ts:37-71` pins `three dialogs`, `never a dialog`, the three names and `Three of them now, not four`;
  `test/claude-rules.test.ts:323-347` pins one anchor per bullet and headline parity, both untouched by a body edit of the Escape bullet.
- `<doc>:185-198` — every doc sentence named exists: DESIGN.md `:186, :247, :369, :391`; `docs/subsystems/board.md:42-59` (table), `:77`, `:110`,
  `:254-256`; `docs/subsystems/invariants.md` Escape section and `:1589`; `.claude/rules/board.md:11-20` names `TrackerPopover` at `:16`;
  `useDialogEscape.ts:18, 30`; `BoardView.tsx:259-262`.
- `<doc>:200-205` — nothing in scope depends on the four out-of-scope items.
