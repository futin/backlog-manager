# Jira board restyle — split Run button, grouped menu, marks on the card, Move-to popover (design, 2026-11-05)

Mocks: `2026-11-05-jira-restyle-mockups/` beside this file (`RunButton.dc.html`, `Card.dc.html`, `Board.dc.html`, `Modal.dc.html`, copied off the canvas
https://claude.ai/artifact/58gdjicygUebSYgFeCU83M, version 5) and `00-mock-audit.md`, which lists what each mock draws, what the code has, and what the
mock drew that this spec does NOT build. Where a mock and this spec differ, the spec wins. Picked direction: **A — split Run + full restyle** (the user's
choice between A and B on the canvas; B's tinted chip and in-menu search stay on the canvas for the record).

## 1. Intent

The Jira section looks like unstyled defaults. The user named three things: the `Run ▾` chip ("too default"), its dropdown (a flat list of labels with a
rule through it), and the board as a whole. The reference points were dribbble board shots (Golo, Hologram, Keitoto, Outcrowd, Uxerflow — listed on the
canvas): what they share is a card that says its facts with small coloured marks instead of grey words, a column header that carries a tone, and a
primary action that looks primary. This spec brings those into the daylight language (`.claude/DESIGN.md`) without a second palette: every colour is a
token the board already has, every tint is `color-mix` of a mark token over a surface, every word on a tint keeps 4.5:1.

## 2. Goals, non-goals, anti-goals

**Goals**

- `Run` is a split button — click runs the default action, the chevron half opens the menu — ink-filled so it reads as the card's one primary action.
- The menu is grouped (built-ins, then the skills on this machine), each row an icon tile, a label and a one-line sub-line; the default row is marked.
- The card carries its facts as marks: a tinted type tile, a priority pill, a status dot before the raw status word, a tinted initials disc.
- Column headers carry the category's tone in the dot and sit on a column ground.
- The detail dialog's Agent column becomes a band with the Run control in it, the Ticket facts get glyph labels, and `Move to…` becomes a status chip
  that opens a popover of transitions.

**Non-goals**

- No change to what a Run does: the launch sheet still opens on every pick, the action vocabulary (`execute`, `context`, skills) is unchanged, and the
  `no-repo` and `live` states keep their meaning and their titles.
- No change to the band (picker, search, Filters, `Board | List` switch), the deck, the fold, the List view, Sessions, Setup, the launch sheet.
- No Done-column dimming, no "PR merged" line on a card, no column `⋯` menu, no sort control, no applied-filters row, no search inside the Run menu —
  all drawn on one mock or another and listed in `00-mock-audit.md` as not built.
- No new theme tokens. No dark-theme-specific rules: the tints are `color-mix` over the theme's own surfaces and follow the theme.

**Anti-goals** (what would make this a failure even if it ships)

- A guard goes red and gets loosened to pass: the uppercase rule, the 11 px floor, the tint-form rule, the contrast rule, the primitives block, the
  dialog count. Every one of them is listed in §3 with the move that keeps it green.
- Jira's own five-colour priority scale on the card. The priority pill has three tones (§4.2), not five.
- A live card on the shelves. A top with a live session leaves the shelves for the deck (DESIGN §8.9.1 "The shelves"); the mock's live card variant is
  not built (§4.2, my call).

## 3. Constraints

These are the repo's guards and rules this work runs into. Each line says what the guard asserts and how this spec stays inside it.

- **Uppercase** (`test/design-guards.test.ts` guard 4): `text-transform: uppercase` in exactly one rule, `.rail-kicker`. The menu's section headers are
  sentence case — `Built in`, `Skills on this machine · 2` — at 11/600 `--ink3` with `letter-spacing: .04em`, never uppercased. The mock's uppercase
  headers are a mock-only rendering.
- **Type floor** (guard, same file): every px font-size ≥ 11 px. The mock's 10.5 px headers and 11.5 px sub-lines become 11 px.
- **Tint form** (`test/daylight-contrast.test.ts`): every tint is `color-mix(in srgb, var(--<mark>) N%, <surface>)` where the mark is `--green-solid`,
  `--amber-solid`, `--red`, `--magenta`, `--cyan` or `--mustard` and the surface is `var(--strip)` or `var(--steel)`; a word on a tint keeps 4.5:1 over
  the tint; `styles.css` never reads bare `var(--amber)` — a mark is `--amber-solid`, a word is `--amber-text` or `--amber-ink`. Every tint this spec
  adds (§4.2, §4.1, §4.4) is listed in §6 so it joins the test's `PINNED` map.
- **Primitives block** (guard): the `ui-*` families are declared once, inside the delimited block. The new `.ui-split` family (§4.1) goes in that block.
- **Dialog count** (`test/dialog-count-docs.test.ts`, `.claude/rules/board.md`, `useDialogEscape`'s comment, `invariants.md`): `Popover` has seven
  composers today. The Move-to popover (§4.4) is the eighth; the rule file's bullet, the hook comment and the test's `seven composers` line move to
  eight together. The DIALOG count (eight: two `Modal`s, five `FormSheet`s, `Confirm`) does not move — a Popover is not a dialog in that count.
- **CSP** (`server/src/security.ts`): `style-src 'self'`. Any per-element colour (none is planned) goes through CSSOM; the tints are class rules.
- **DESIGN.md is the visual language**: where this spec contradicts a §8.9 sentence, §7 lists the override and the plan carries a DESIGN.md task.
- **The Run control on a Jira card is never hidden for the dashboard's sake** (`board.md`): the split button keeps that — it is the environment block's
  exception, as the chip was.
- **Run ▾'s test selectors** (`test/jira-detail.test.tsx`, `jira-launch.test.tsx`, `jira-board.test.tsx`): the button named `Run <key>` stays — it is
  the split's LEFT half; the menu stays `role="dialog"` named `Run menu`; rows stay findable by their label. §6 lists what each test changes.

## 4. Decided

### 4.1 The Run control (`JiraRunMenu`, mock `RunButton.dc.html`, column A)

**Shape.** One group, `.jira-run`, holding two buttons that share one outline: the LEFT half (`Run <key>` by `aria-label`, as today) is a play glyph
(14 px outline, `currentColor`) and the word `Run`; the RIGHT half (`aria-label="Run options for <key>"`, `aria-haspopup="dialog"`,
`aria-expanded`) is the `Chevron`, turning `up` while the menu is open. 28 px on the card, 32 px in the dialog (`home` keeps deciding the size, as it
does today). Radius 10. Ink fill: the `.ui-chip-ink` precedent — `--ink` ground, `--on-accent` text — with a 1 px divider between the halves in
`--on-accent` at reduced opacity (builder's call how: an `opacity` on a pseudo-element, not a `color-mix` over `transparent`, which the tint guard would
read as a malformed tint). Hover lifts the half under the pointer one step (`--ink2`), never both.

**Primitive.** This is a new ui family, `ui/SplitChip` (`.ui-split`, `.ui-split-main`, `.ui-split-more`, size modifier `.ui-split-28`), declared once in
the primitives block, so the Board's dispatch button can adopt it later without a second declaration. Props: `label`, `labelMore`, `onMain`, `onMore`,
`open`, `disabled`, `dashed`, `size`, `title`, `icon`. It is two `<button>`s in a `<span role="group">`, not one button with two targets.

**Left click** = pick the preferred action — `resolveJiraAction(settings.jiraDefaultAction, data.skills)`, the row the menu marks `default` — exactly as
choosing that row does today: `onPick(row)`, the launch sheet opens with that action. The menu does not open. **Chevron click** = the `Popover`.

**States** (from `runChipState`, unchanged):

- `ready`: as above.
- `no-repo`: both halves disabled, the group drawn as the dashed outline chip is today (`--strip` ground, dashed `--hairline2`, `--ink3` text), the left
  half reads `Run`, the title on the group and both halves `no repository mapped for <key> — Jira › Setup › Repositories`. Opens nothing.
- `live`: both halves disabled; the group is a green tint — `color-mix(in srgb, var(--green-solid) 14%, var(--strip))`, the `.ui-pill-done` tint — with
  `--green` text; the left half reads `Running` followed by ` · <age>` when the age is known (`pollAge` of the newest live session's start), with a 6 px
  `--green-solid` dot before the word (a steady dot, no animation — the deck card already carries the pulse, and two pulses on one page is one too many);
  the title stays `a session is running on <key>`. The `aria-label` of the left half stays `Run <key>` (the tests' handle). On the shelves this state is
  never seen — a live top is on the deck — so it is in practice the dialog's.

**The menu** (`.jira-run-menu`, a `Popover` named `Run menu`, `role="dialog"`, 300 px in both homes — the dialog's Agent column is an even split of a
1000 px shell, wide enough; `MODAL_PANEL_WIDTH` goes). Radius 14, padding 8. Contents, in order:

1. Section header `Built in` — 11/600 `--ink3`, `letter-spacing: .04em`, 8 px above, 4 px below, 8 px inset.
2. The two built-in rows, `execute` then `context`.
3. Section header `Skills on this machine · N` — N the count of `data.skills`. The section is OMITTED when N is 0 (no header, no empty row).
4. One row per skill, in `data.skills` order.
5. Footer line `Every choice opens the launch sheet first` at 11 px `--ink2`, 8 px inset, above a hairline. No keyboard hint — there is no shortcut.

A **row** (`.jira-run-opt`, a `<button>` titled with its label) is 40 px: a 28 px radius-8 icon tile — `--strip-hi` ground, 14 px outline glyph in
`--ink2` — then a column of the label at 13/500 `--ink` and a sub-line at 11 px `--ink3`; for `execute` the sub-line is `Work the ticket end to end`, for
`context` `Open with the ticket loaded`, for a skill its slash command (`skillCommand(k.prompt)`) in the monospace stack. Hover `--strip-hi`. The row
that is the preferred action is marked in place — it does NOT move to the top of the menu any more (grouping beats "default first"; the mark says which):
its tile is `color-mix(in srgb, var(--green-solid) 14%, var(--strip))` with the glyph in `--green`, and the row's right end carries a 14 px stroked tick
and the word `default` at 11/500 `--green`. The ARIA name of every row is its label alone (the sub-line and the mark are `aria-hidden`), so
`getByRole('button', { name: /Groom ticket/ })` keeps finding it.

**Glyphs.** `execute` = play; `context` = a document with lines; a skill = a four-point sparkle. Outline, 1.5 px stroke, `currentColor`, 14 px box — the
`JiraTypeIcon` register. They live in one new file, `client/src/components/ui/Glyphs.tsx`, with the facts glyphs of §4.4 (person, flag, branch, tag,
calendar, status ring). Builder draws the paths.

**Keyboard and closing.** As today: the group stops the card's click and Enter/Space; the popover joins the Escape stack and closes on click-outside;
after a pick the menu closes and focus returns to the chevron half.

### 4.2 The card (`JiraCard`, mock `Card.dc.html` "proposed · idle"; `Board.dc.html` for the columns)

Still §8.3's card composed, not a second card: `.board-card`'s ground, radius, padding, gap and 14/500 title are untouched. The rows become:

1. **Head**, 12 px: an 18 px radius-5 **type tile** holding the `JiraTypeIcon` glyph — bug: `color-mix(in srgb, var(--red) 12%, var(--strip))` ground,
   `--red` glyph; story: `color-mix(in srgb, var(--green-solid) 14%, var(--strip))` ground, `--green` glyph; every other type (task, sub-task, epic and
   above): `--strip-hi` ground, `--ink2` glyph. The type name stays the tile's title. Then the **key at 600 `--ink`** (was 500 `--ink2`), then the crumb
   as today (`root` / `↳ PAY-120 Refund flows` / `Assigned to me`, ellipsised, the one that gives), then the **priority pill** pushed right (below).
2. **Title**, unchanged.
3. **Who row**: a **22 px initials disc** on `color-mix(in srgb, var(--magenta) 14%, var(--strip))` with the initials at 11/600 `--magenta` (unassigned:
   empty, dashed `--hairline2` outline on `--strip`, as today's `.none`), the name at 12/400 `--ink2` ellipsised; then the **status as a 6 px dot and the
   raw status name** at 12/500 `--ink2` — the dot `--ink3` for the `todo` category, `--amber-solid` for `doing`, `--green-solid` for `done` — replacing
   the neutral `Pill`; then the age at 12 `--ink3` and the `↗` link, unchanged.
4. **Fold block**, unchanged.
5. **Foot**: on the left, the **mapped repository** — a 14 px branch glyph and the repo's name at 12 px `--ink3`, drawn only when `runChipState` finds a
   mapping (the `no-repo` state's dashed button says the rest; nothing is drawn twice) — then the existing markers in their order: F1's `match` marker
   in `--amber-text`, the worktree chip `.jira-card-tree`; on the right, pushed, the **28 px split Run** of §4.1. The marker row is this foot now; it is
   always drawn (the Run control is always in it).

**The priority pill** (`.jira-card-prio`, 18 px, radius 999, 11/500, 8 px inset, a 10 px glyph then the name): three tones by the priority's NAME,
case-insensitive — `Highest` and `High`: `color-mix(in srgb, var(--red) 12%, var(--strip))` with `--red` text and an up-triangle glyph; `Medium`:
`color-mix(in srgb, var(--amber-solid) 14%, var(--strip))` with `--amber-ink` text and an `=` glyph; `Low` and `Lowest`: `--strip-hi` with `--ink3` text
and a down-triangle; any other name Jira hands back (custom schemes): the `Low` tone with no glyph. `null` draws nothing and the head keeps its shape.
`title` is `priority <name>`. This overrides DESIGN §8.9.1's "a priority is a fact … not a state this board colours" (§7): the user asked for the card to
carry its facts as marks, and three tones over the board's own red/amber/grey is not Jira's five-colour scale. The pill's words keep 4.5:1 over their
tint, so `daylight-contrast` pins them like `.ui-pill-warn`.

**Not built, my call** — the mock's "proposed · live" card (green border, 3 px progress strip, `Working · 12m · tests`, `Open session` chip): a live
top leaves the shelves for the deck, which already draws exactly those things. Building both would put one session in two places. The Done column's
dimmed cards and `PR #1182 merged` line: there is no PR fact on a `JiraIssue`; nothing to draw from.

### 4.3 Columns (`BoardColumn`, `.jira-board-columns`; mock `Board.dc.html`)

Jira's three columns get a **ground**: `--steel`, radius 16, 12 px padding, the header inside it — and the header's dot takes the category's tone:
`--ink3` for To Do, `--amber-solid` for In Progress, `--green-solid` for Done; the name at 13/600 `--ink`; the count pill on `--strip` (white on the
steel ground) at 11/500 `--ink2`, still counting cards. `BoardColumn` grows one optional prop, `tone?: 'todo' | 'doing' | 'done'`, that only the Jira
board passes: the Board and Archive columns are unchanged (plain dot, ramp hues, no ground), so §8.3 and §8.5 stand. DESIGN §8.9.1 "Columns" is
overridden only in the dot's colour, and only for Jira, where a status category IS the column's one fact (§7). No `⋯` menu — there is nothing behind it.

### 4.4 The detail dialog (`JiraDetail`, mock `Modal.dc.html`)

**Head.** The type tile of §4.2 replaces the bare glyph in the crumbs; the key at 600 `--ink`, `· <type>`, `· in <parent>`, `· <sprint>` as today;
`Open in Jira ↗` as today; the 22/600 title stays (the mock's 19 px is the mock's).

**Agent column** → a **band** (`.jira-detail-agent-band`: `--board` ground, radius 12, 16 px padding) at the top of the column, holding the `Agent`
label row as today and, when no session is live, the empty state: a 36 px dashed-outline tile with a 16 px robot glyph in `--ink3`, `No session on this
ticket` at 13/500 `--ink`, a sub-line at 12 `--ink3` reading `<repo name> · default: <default action's label> · last run <age>` with each part omitted
when unknown (no repo mapped → `no repository mapped`; never run → part omitted), and the **32 px split Run** pushed right on the same row. When
sessions are live, the live cards (`.jira-sess`, unchanged, Jira sessions spec) follow inside the band and the Run control sits on the label row. The
`History` list is unchanged and sits under the band. `.jira-modal-controls jira-detail-run` goes — the control has a home now.

**Ticket column.** The `dl.jira-detail-facts` stays a dl on a pane of `--board` ground, radius 12, 16 px padding; the label column narrows to 96 px and
every `dt` is a 14 px glyph then the word: `Status` (a ring), `Assignee` (person), `Reporter` (person), `Priority` (flag), `Sprint` (calendar),
`Parent` (branch), `Labels` (tag), `Created · updated` (calendar). Values as today, except: the priority value is §4.2's pill; the assignee value gets
the 22 px tinted disc before the name; labels draw as 24 px `--strip-hi` chips at 11/500 `--ink2` (`.jira-detail-label`), wrapping.

**Status and Move to.** The status `Pill` and the `Move to…` `Select` become ONE control: a 28 px `Chip` (`.jira-detail-status`) reading a 6 px category
dot, the raw status name and the `Chevron` — `aria-label="Move to"`, `aria-haspopup="dialog"`, `aria-expanded` — opening a 240 px `Popover` named
`Move to` (`role="dialog"`, the eighth composer, §3) under it: a header `Move to` at 11/600 `--ink3` (sentence case), then one 36 px row per transition
the detail offers, in Jira's order, each a 6 px dot in the LANDING status's category tone and the landing status's name at 13/500 `--ink` — the row whose
landing status is the current status, when Jira offers one, drawn first with a stroked tick and `aria-disabled`; hover `--strip-hi`; a footer `Jira
transitions, applied on click` at 11 px `--ink3`. A pick posts `POST /api/jira/issue/transition { key, transitionId }` at once and closes the popover,
exactly as the select's change did; the error line `.jira-modal-error` is unchanged. The chip is disabled, with the SAME titles — `transitions
unavailable` after a failed detail read, `no transitions offered` when Jira offers none — and opens nothing; while the detail is loading it is disabled
with no title, as the select was. The category word that followed the pill (`· to do`) goes: the dot says it.

`Assign to me` is unchanged: a 28 px `Chip` after the assignee value.

### 4.5 What does not change

The `Select` primitive stays (Settings uses it). `Pill` keeps `neutral` (the deck, Sessions, Children use it). `Marker` keeps `kind` (the Board card's
markers). `JiraTypeIcon`'s paths are unchanged — it gains a wrapper tile, not new glyphs. The launch sheet, the deck card, the List, Sessions and Setup
are not touched by this work.

## 5. Left to the builder

- Glyph paths (`ui/Glyphs.tsx`): play, document, sparkle, robot, person, flag, branch, tag, calendar, ring, tick, up/down triangle, `=`. 14 px box,
  1.5 px stroke, round joins, `currentColor`.
- The split's divider mechanism, inside the tint-form guard (§4.1).
- Whether `.jira-run-opt`'s icon tile and the detail's facts glyphs share a `.ui-glyph-tile` rule or stay Jira-local; the primitives-block guard decides
  the first (declare once, in the block).
- The exact `pollAge` source for the live state's ` · <age>` (the newest live session on the issue, `agents` as `JiraCard` reads them).
- Focus order inside the Move-to popover (first enabled row on open is the sensible default; the Run menu's precedent).
- The under-700 px fold of the dialog: the Agent band stacks above the Ticket pane, as the columns already do; the builder checks the 32 px Run and the
  popovers at that width.

## 6. Tests this changes or adds (behaviour and cases, not code — the plan states this override of writing-plans' literal-code rule)

- `test/jira-detail.test.tsx`: `moveSelect()` becomes the button named `Move to` (`aria-haspopup="dialog"`); opening it shows a dialog named `Move to`
  with one row per transition named by its landing status; a row click posts `{ key, transitionId }` once and the dialog closes; the chip is disabled
  with title `transitions unavailable` after a failed read and `no transitions offered` on an empty list; the current status's row is first and
  `aria-disabled`. `modalRun()` (`Run PAY-131`) still finds the left half; clicking it opens the launch sheet with the default action WITHOUT a dialog
  named `Run menu` appearing; the button named `Run options for PAY-131` opens that dialog; the `live` and `no-repo` cases keep their disabled and
  title assertions on the left half, and assert the right half is disabled too.
- `test/jira-launch.test.tsx`, `test/jira-board.test.tsx`: the card's foot holds a button `Run <key>` and a button `Run options for <key>`; the menu's
  rows are found by label; the row carrying `default` is the resolved default action and is NOT first when the default is a skill; the `Skills on this
  machine · N` header is absent when `data.skills` is empty; the repository name is drawn in the foot only when mapped.
- `test/jira-board.test.tsx` (card marks): priority `High` draws a pill titled `priority High` with the red tone class; `Medium` the amber tone;
  `Lowest` the grey tone; an unknown name the grey tone with no glyph; `null` draws no pill. Status text keeps the RAW name (`In Review`), with a dot
  element carrying the category's tone class. The type tile carries `bug` / `story` / neutral tone classes by `type.name` and `subtask`.
- `test/dialog-count-docs.test.ts`, `.claude/rules/board.md`, `useDialogEscape`'s comment: `seven composers` → `eight composers`, naming `JiraDetail`'s
  Move-to popover; the eight-DIALOG assertions do not move.
- `test/daylight-contrast.test.ts` `PINNED`: add every new tint site with its hue, percentage and surface — `.jira-card-type[data-tone="bug"]`
  (`--red` 12 `--strip`), `[data-tone="story"]` (`--green-solid` 14 `--strip`), `.jira-card-prio[data-tone="high"]` (`--red` 12), `[data-tone="med"]`
  (`--amber-solid` 14), `.jira-card-av` (`--magenta` 14), `.jira-run-opt-default .jira-run-tile` (`--green-solid` 14), `.ui-split[data-state="live"]`
  (`--green-solid` 14) — selectors are the builder's, the hue/percentage/surface are this spec's; and the words on them (`--red`, `--amber-ink`,
  `--magenta`, `--green`) pass the 4.5:1 check over their tints on daylight.
- `test/design-guards.test.ts`: the `.ui-split` family is declared once inside the primitives block; no new rule uppercases; no font-size under 11 px.
- `test/ui-chip.test.tsx` gains, or a new `test/ui-split.test.tsx` holds: `SplitChip` renders two buttons in a group; `disabled` disables both; `dashed`
  sets the dashed class; `onMain` and `onMore` fire from their own halves only; Enter/Space on either half does not reach the parent.
- Last plan task is `/ui-verify`: the shelves at 1440 px against `Board.dc.html`, a card against `Card.dc.html` (idle), the open menu against
  `RunButton.dc.html` column A, the dialog with the Move-to popover open against `Modal.dc.html`.

## 7. DESIGN.md overrides (the plan carries one task to write these into §8.9.1 and §8.9.2)

- §8.9.1 "The card": the head's key weight and colour (600 `--ink`); the type glyph sits in a tinted tile; the status `Pill` becomes dot + word; the
  initials disc is 22 px and magenta-tinted; the marker row becomes the foot and carries the repository name; the priority leaves `Marker tone="kind"`
  for a three-tone pill — the sentence "a priority is a fact about the issue, not a state this board colours" is replaced, with the reason in §4.2.
- §8.9.1 "Columns": the Jira dot takes the category tone and the column has a `--steel` ground; "the plain dot out of scope draws on Archive" stays
  true of Archive.
- §8.9.1 "`Run ▾` and the ended line": the chip is a split button; "pulled first with `default`" becomes "marked in place with `default`".
- §8.9.2 "Agent column", "Ticket column", "Controls": the band, the glyph labels, the status chip + popover replacing `Pill · category` + `Select`.
- §8.7: `Popover` composers seven → eight.

## 8. Rejected on the way

- Direction B (tinted chip, search inside the menu, a `change the default` link): the search solves a list this machine does not have (two to five
  skills), and the tinted chip read as a state, not an action. Stays on the canvas.
- Pulling the default row to the top of a grouped menu: it broke the grouping it sat in.
- A pulse on the live Run state: the deck card pulses; one pulse per page.
- Jira's five priority colours; a `⋯` column menu; a sort chip over a fixed order.
