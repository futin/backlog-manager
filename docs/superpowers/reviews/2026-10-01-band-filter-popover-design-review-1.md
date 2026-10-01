# Review 1 — `docs/superpowers/specs/2026-10-01-band-filter-popover-design.md`

Date: 2026-10-01. Reviewer: a fresh Fable session, handed only the spec path and the checklist. Every claim below was checked against the code named;
`<doc>:<line>` is the spec, every other `file:line` is the repo (or the dashboard, where `../claude-agents-dashboard/` is spelled out).

## Verdict: REVISE

One Critical: the spec deletes the tracker popover's phone rule with nothing in its place, which regresses the popover to invisible below 700 px and turns an
existing source guard red. Seven Important findings, most of them "an implementer must guess" — the stored-status edge, the sort re-pick, where the panel is
positioned from, where the direction key lives, and a stated fact about `Chip`'s pressed look that is false. The rest of the spec checks out well: every
dashboard measure in §1 is byte-accurate against its stylesheet, the Escape-stack reasoning matches the hook, the four suites named in §4 are exactly the
four that drive the selects, and the invariants it touches are respected.

## Critical

### C1 — `<doc>:64-65` with `<doc>:32-34`: the tracker popover's phone rule is dropped, and nothing replaces it

The spec says `.tracker-pop`'s "own shell rule goes — position, radius, padding and shadow are `Popover`'s now", and defines `Popover`'s position as
"8 px below its button, right-aligned to it" with a `calc(100vw / --font-scale - 48px)` cap. That describes the desktop rule only. The second `.tracker-pop`
rule, inside the 700 px block, is not a shell detail — it is a bug fix:

- `client/src/styles.css:358-364` — `.tracker-pop { position: fixed; top: auto; margin-top: 6px; left: 12px; right: 12px; width: auto; max-height: 70vh;
  overflow-y: auto }`, with the comment explaining why: on a phone the chip lives in the rail bar, the narrow `.rail` is a scroll container
  (`overflow-x: hidden` computes `overflow-y` to auto, `styles.css:276-280`), so an absolute popover is clipped to the 53 px bar and paints nothing — and
  right-anchored under a chip beside ☰ it would start off-screen besides.
- `test/tracker-chip.test.tsx:144-157` — a source guard that reads the 700 px media blocks and asserts `.tracker-pop {` carries `position: fixed`,
  `top: auto`, `left: 12px`, `right: 12px`, `width: auto`. The comment says why it is a source guard: jsdom does no layout, so behaviour cannot catch it.

Built as written, the popover regresses to the exact state that rule fixed, and the guard goes red against a selector that no longer exists. §4's
"Tracker chip (its existing suites) — every current behaviour holds" does not reach it, because the behaviour lives in a stylesheet rule and the suite
pins the selector by name.

**Fix:** state where the phone rule lives after the move — the obvious answer is on `.ui-popover` inside the 700 px block (fixed, `top: auto`, 12 px
insets, `width: auto`, `max-height: 70vh`, scroll), so every popover escapes the rail the same way — and say which selector
`tracker-chip.test.tsx:144` reads after the move (it becomes a `Popover` suite case). If `Popover` carries it generically, the band's two popovers also
go fixed and full-width below 700 px; say so (it is probably the right answer — see I3).

## Important

### I1 — `<doc>:43`: `Chip`'s `pressed` is not "the filled ink look"

"pick chips are `Chip` at `size={28}` with `pressed` for the chosen one (that is the filled ink look the mock draws)". It is not:

- `client/src/styles.css:2561` — `.ui-chip.on { background: var(--strip-hi); border-color: var(--ink3) }` — a pressed outline chip is paper-highlight
  with a darker stroke; the label keeps its colour.
- `client/src/components/ui/Chip.tsx:16-18` — by design: "`pressed` is `aria-pressed`, never a colour alone … the fill moves and the label does not
  change colour."
- The look the mock copies is the dashboard's `.pick.on { background: var(--ink); border-color: var(--ink); color: var(--strip) }`
  (`../claude-agents-dashboard/client/src/styles.css:692`).

An implementer has three incompatible ways out: accept `Chip`'s pressed look and diverge from the mock; render the chosen chip as `variant="ink"` (a
variant swap on a state, which `Chip.tsx:16-18` and §8's "a raised control marks a state" argue against, and which changes the label colour); or restyle
`.ui-chip.on` for every pressed chip on the board. **Fix:** pick one and say it. If the ink look is wanted, say the chosen pick is `variant="ink"` and
rewrite `Chip.tsx`'s pressed paragraph; if `pressed` is enough, drop the parenthetical and call the mock difference out (checklist 4).

### I2 — `<doc>:95`: the direction key does not belong in `lib/view-keys.ts` by that module's own rule

"a new persisted value under a new key in `lib/view-keys.ts`". The module says the opposite:

- `client/src/lib/view-keys.ts:3-4, 12-15` — "Exactly one lives here … `STATUS_KEY` and `SORT_KEY` deliberately stay local to BoardView. They are
  Board-only questions: Archive carries no status filter … and no sort control."
- `client/src/components/board/BoardView.tsx:30-35` — restates it: "The two below stay local because Archive has neither control."

The direction is Board-only too (`<doc>:74`: Archive gets no sort prop). **Fix:** declare it beside `SORT_KEY` in `BoardView.tsx`. If the spec wants it
shared, say why and add `view-keys.ts`'s header to §5's doc list.

### I3 — `<doc>:33-34, 41`: where the band's popovers land below 700 px is unspecified

`Popover` is "right-aligned to its button"; the only phone rule in the spec is that the sort label is not drawn. But the band's right slot wraps:
`client/src/styles.css:2498` — `.ui-band-right { display: flex; flex-wrap: wrap; … margin-left: auto }`. At 375 px the run chip, the search field, the
track and Orchestrate wrap onto two or three rows, and nothing says where the track lands on its row. A 300 px panel right-aligned to a 34 px button
that wrapped to the left of a row extends ~170 px past the left edge of the screen. The dashboard avoids this with `.ctlwrap { margin-left: auto }`
(`../claude-agents-dashboard/client/src/styles.css:673`) and by hiding only the readout. **Fix:** state the track's position in the wrapped band (e.g.
`margin-left: auto`, last before Orchestrate), or make the panel fixed and full-width below 700 px as the tracker's is (C1) — one rule for all three.

### I4 — `<doc>:53` with `<doc>:32-33`: what positions the panel is not stated

`Popover` takes "the `anchor` element (the button that opens it, as a ref)" and is "8 px below its button, right-aligned to it". Those two sentences
together read as "positioned relative to `anchor`" — a `getBoundingClientRect` or a portal. The existing shape is nothing of the kind: the panel is
`position: absolute; right: 0; top: calc(100% + …)` inside a `position: relative` wrapper that holds BOTH the button and the panel —
`client/src/styles.css:311` (`.tracker-chip-root { position: relative }`) wrapping `TrackerChip.tsx:61-93`, exactly as the dashboard's `.ctlwrap`
(`../claude-agents-dashboard/client/src/styles.css:673, 683`). **Fix:** say that the caller's wrapper is the positioning context (`FilterBar` gets one,
`TrackerChip` keeps `.tracker-chip-root`) and that `anchor` serves the pointer-outside test alone.

### I5 — `<doc>:96-97`: re-picking the already-chosen sort key is ambiguous

"Picking a key in the popover sets its natural direction; the switch then flips it." Read literally, picking `Name` while already on `Name (desc)` resets
to `Name (asc)`. The dashboard this copies does not — `../claude-agents-dashboard/client/src/components/Toolbar.tsx:139` sets `sortKey` alone and leaves
`sortDir` as it was. §4's case at `<doc>:136` covers only a key CHANGE. **Fix:** state the rule for a re-pick and add the case.

### I6 — `<doc>:84-85`: an unrecognised stored status loses its documented recovery

"Status: unchanged state and values." The state is deliberately unguarded: `client/src/components/board/BoardView.tsx:168-175` — a stale stored status
"just matches nothing in the four type columns, leaving a visibly narrowed board whose cause is the select sitting right above it and whose fix is one
click." Behind a popover, nothing in the band shows the value; the four-way `Segmented` lights no option, the badge reads `1` (since `≠ open`), and the
count line reads `0 items` (`BoardView.tsx:484`'s `?? 'items'`). That may be acceptable — `Clear all` is one click — but the spec is silent on this
"old stored data" case while covering the same case for sort and project. **Fix:** state what the switch and badge show for a value outside the four,
and that `Clear all` is the recovery; the BoardView comment is rewritten (§5).

### I7 — `<doc>:153-161`: the docs list misses four places that name what moves

- `client/src/hooks/useDialogEscape.ts:30-31` names `TrackerPopover` as "the second non-dialog entry", and `:72` lists "the tracker popover" as a call
  site. After this change the entry is `Popover` (three mounts). `test/dialog-count-docs.test.ts:65-71` reads this comment and pins the phrase
  `Three of them now, not four`, so the rewrite must keep it.
- `docs/subsystems/board.md:110` names `ui/Confirm` as the stack's one non-dialog entry; `:254-256` names `TrackerPopover` and its three closers.
- `docs/subsystems/board.md:72` lists what sits at the top level of `components/` and why (two lazy chunks read it); `FilterBar` joins that sentence.
- `client/src/components/board/BoardView.tsx:259-262` — "The selects survive that objection because each one permanently states its own value in the
  bar" is the stated reason the query is not persisted while the filters are; it stops being true and must be rewritten (the count line and badge are
  the new answer).

**Fix:** add them to §5.

## Minor

- M1 `<doc>:45` — `FilterBar`'s class family is unnamed. Guard 7 (`test/design-guards.test.ts:366-388`) rejects any selector outside the primitives
  block whose class tokens start with a family name, so it must not begin `.ui-`; name it (`.filter-bar`?) so the plan does not invent one.
- M2 `<doc>:66-67` — the visible-change list omits the offset: `client/src/styles.css:339` is `top: calc(100% + 6px)`; `Popover` is 8 px.
- M3 `<doc>:111` — "the assertion about what the board shows stays the same" is not true for the count line: `test/board.test.tsx:312-313` expects
  `2 done` after picking alpha and will expect `2 done in alpha`. Say the count-line assertions gain the suffix.
- M4 `<doc>:141` — `test/archive.test.tsx:337` asserts `queryByLabelText('Sort')` is absent; after the change the sort control's name is
  `Change sort` (`<doc>:76`), so the case must query that name or it asserts nothing.
- M5 `<doc>:146` — the tracker list omits two things the suites assert that stay in `TrackerChip`, not `Popover`: close on section change
  (`TrackerChip.tsx:36-37`, `test/tracker-chip.test.tsx:314-319`) and the dialog's accessible name `Tracker` (`:303-311`, `:321-331`), which becomes
  `Popover`'s `label`.
- M6 `<doc>:150` — `FAMILIES` entries carry the leading dot (`test/design-guards.test.ts:314-331`): `.ui-popover`.
- M7 `<doc>:32` — `.acct-pop`'s cap is `100vw - 24px` (`../claude-agents-dashboard/client/src/styles.css:430`), `.pop`'s is `- 48px` (`:683`); "share
  one shell" is true of paint, not of width. The spec's 48 is fine; the sentence overstates.
- M8 `<doc>:159-161` — the guard for the rewritten bullet and entry is `test/dialog-count-docs.test.ts:37-59` (pins `three dialogs`, `never a dialog`,
  `item modal`, `LaunchSheet`, `OrchestrateSheet` in the bullet; `all three dialogs`, `RunDrawer`, `inline` in the entry), not only
  `claude-rules.test.ts`. "Still three dialogs counted" satisfies `/three dialogs/`; name the test so the plan runs it.
- M9 `<doc>:3` — the mock is not in the repo, so checklist 4's mock comparison cannot be made; §1 is the only record. Consider keeping the contact sheet
  under `docs/superpowers/mocks/`, or say it is not kept.
- M10 `<doc>:155` — `docs/subsystems/invariants.md:16` says "§8.7 of `.claude/DESIGN.md` keeps `Modal` to one composer and nothing else floating"; the
  band now floats two panels. One clause in §8.7 or that entry.
- M11 `<doc>:87` — add the `all` example: with Status `All` and a project picked the line reads `9 items in brickwright` (`BoardView.tsx:58, 489`).
- M12 `<doc>:38-40` — the sort popover's foot line (`Live cards always sort first, whatever the order.`) is this board's own copy, not the dashboard's;
  fine, but say so, since the paragraph otherwise reads as a copy.

## Verified true (no finding)

- §1's dashboard measures: `.seg` (`--hairline2`, 12 px, 3 px), `.ictl` 34 × 30 with 18 px / 1.5 stroke icons, `.vsep` 1 × 18 `--ink3` at .45, `.sortlab`
  13 px `--ink2` with `--ink` 500 key, `.ictl .n` 16 px `--ink`/`--strip` at 10 px, `.seg>button.on` raised on `--strip` with `0 1px 2px var(--shadow)`,
  `.pop` shell and 300 px width, `.pop-h .clear` 12 px `--ink2`/`--ink3` disabled, `.opt .hint` 11 px, `.pop-div`, `.sw` —
  `../claude-agents-dashboard/client/src/styles.css:430, 669-707`.
- `TrackerChip`'s two dismissal owners, its `useDialogEscape` shape and the reason `useDismiss` was not copied — `client/src/components/TrackerChip.tsx:19-22,
  39-46, 136-154`; `client/src/hooks/useDialogEscape.ts:61-103` (LIFO, identity removal, `[]` effect).
- `.tracker-pop`'s desktop shell (16 px, `0 24px 64px`, no border, `14px 16px`, 420 px) — `client/src/styles.css:338-342`.
- `Chip size={28}`, `Segmented pill` (Settings density/text-size rows at `SettingsView.tsx:289, 298`), `Dot hue` — `Chip.tsx:4, 27`, `Segmented.tsx:23-44`,
  `Dot.tsx:36`.
- Project state, fail-open, status values/labels, sort keys and `created` fallback, `liveRank` primary, `project` tie-break newest-first, count line,
  Orchestrate's four conditions and click-time capture — `BoardView.tsx:34-42, 96-99, 176-177, 264-266, 280-284, 484-489, 522-541, 690-731, 794-803`.
- Archive: project only, `${n} archived`, fail-open — `ArchiveView.tsx:138-153, 174-180, 193-194, 238-271`.
- §4's suite list is complete: the selects are driven only by `board`, `board-live-cards`, `orchestrator-start-ui`, `tracker-board` and `archive`
  (`runs-view.test.tsx` drives the Runs band's own select, which is out of scope).
- The guard-7 prefix test cannot collide: `.ui-popover` starts with no existing family.
- Invariants: Escape has one owner (joins the stack, no second `keydown`); `--main-gap`, `contentWidth`, the one-home rule and `FilterBar`'s top-level
  placement by the two-lazy-chunks rule (`docs/subsystems/board.md:72`) are all respected.
