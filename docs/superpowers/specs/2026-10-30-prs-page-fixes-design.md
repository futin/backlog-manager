# GitHub › PRs — one row vocabulary across Inbox, Matrix and Cards

Date: 2026-10-30. Supersedes, where they differ, the "Layout key", "Empty states" (its Cards clause), "Inbox" (its "Compact keys" run-in included), "Matrix",
"Cards", "What every layout carries" and "One actions component" sections of `2026-10-29-prs-layouts-design.md`; everything that spec says and this one does not
touch still holds — the three levels, the ranking, reach and the hidden-repo note, GitHub › Settings' Access card, the page owning marks, outcomes and writes.
Issue #397 (`branch updated`) is closed by this work.

## Intent and the why

The PRs page draws one pull request three ways, and each way had its own bugs. Inbox picked two or three keys per row from the PR's state, so a row's
controls moved as the PR moved, and `Merge…` swapped itself for a full strip that never folded back — the "weird actions button". Matrix, the layout that
gets used, drew a write's outcome as a white row outside the tinted expansion, said `updating…` in two places at once, disabled `Update branch` with
`already up to date` while the branch was being updated, let the Base header's count drop while an update was in flight, drew a repo that could not be
read as if it were a PR row, and disappeared from the switcher on a narrow window. Cards drew every registered repo — empty ones and failed ones as whole
sheets — with the full strip open under every PR and the same disabled reasons repeated down the page.

The fix is one vocabulary. Every PR, in every layout, carries the same four keys in the same order, says a blocked key's reason in the same place, and has
the same foot under it — a confirm, then an outcome. A person who has learned a row in Inbox has learned it in Matrix and in Cards.

## Goals

- One key strip: `Merge · Auto-merge · Update · Open ↗`, in that order, on every PR in every layout, never one more, one fewer, or reordered.
- A blocked key stays where it is, greyed; its reason is reachable by hover and by screen reader on the key, and a reason the row's own facts do not
  already state is written once, under the keys, as one line.
- `Auto-merge` is one key that reads its state, never two labels.
- The merge confirm and a write's outcome sit in one slot under the row — the foot — in every layout, inside the row's own block.
- Matrix is a Matrix at every width: it scrolls sideways, its PR column stays put, and the switcher always offers it.
- Cards draws only repos with open pull requests; empty repos are a count, failed repos are a note.
- A fast `update-branch` ends in `branch updated` on the row, not in silence (#397).

## Non-goals

- Phase 2, a Board layout with stages (running CI / ready to merge / needs update / has conflicts) — later, its own brainstorm.
- Any server change: `GET /api/prs` and the three write routes keep their shapes; `PR_UPDATING_MS` stays 30 s.
- A new write: the keys send the three POSTs that exist, nothing else.
- Any change to the tracker chip, GitHub › Settings, the Access card, or the Inbox tiles and filter.
- Redrawing the chips vocabulary (`prChips`), the verdict sentences (`prProblems`, `prVerdict`), the levels or the ranking.

## Anti-goals

- A key whose label, place or presence changes with the PR's state. That is the bug this design exists to remove.
- A reason for a blocked key that exists only on hover and that the row's own facts neither state nor imply. §8.11's rule stands: a phone has no hover.
- One surface saying `updating…` twice.
- Three vocabularies for one PR: every NEW word — a key's label, a reason — must be the word the cells, chips and verdict already use for that fact; today's
  three spellings of behind are not this spec's to unify.
- A primitive restyled from the page (DESIGN guard 7). Any new look lands in `components/ui/`.

## Data

`PullRequestsPayload`, `PrRepoView` and `PullRequestRow` in `shared/types.ts` are the whole input, unchanged; `usePullRequests`
(`client/src/hooks/usePullRequests.ts`) changes one type, its `refresh` resolving the payload (Outcomes, below). The page keeps owning `outcomes`, `marks`,
`inFlight` and `write` in `PullRequestsView` (`markUpdating` and `dropMark` stay page-local), handed down as `PrLayoutProps` — which gains one pair, the
confirming row's key and its setter (One confirm, below).

## The derivations (`client/src/lib/`)

Every rule below has one home in `lib/prs.ts` or `lib/pr-layouts.ts` and no component re-derives it. Names are suggestions; the behaviour is the contract.

**The key set** is a constant of four, in order: `merge`, `auto-merge`, `update`, `open`. `compactKeys` goes; what remains of it is `primaryKey(pr, repo,
updating)`: `update` when the PR is behind its base and `updateBlock` is null; otherwise `merge` when the PR is Quiet, not a draft, its checks are not
pending and `mergeBlock` is null; otherwise null. Today's cases hold, plus one: a behind PR whose update is in flight (`updating` true) has no primary,
because its update is blocked.

**The blocks** keep their shape — the first reason that applies, or null — with these changes:

- `mergeBlock(pr, repo)`: unchanged (sync off → draft → not mergeable → checks failing → no merge method allowed).
- `updateBlock(pr, repo, updating)`: sync off → `updating…` while the mark holds → fork does not allow edits → then, only when GitHub says the PR cannot be
  updated (`canUpdateBranch` false): `no permission to update` if behind, else `already up to date` → null for a PR that can be updated, as today. `updating…`
  comes second so that it wins over `already up to date` for the whole of the mark. Its `updating` argument is the mark's PRESENCE (`marks` holds the key), not
  `isUpdating`'s clock, so a 15 s page tick can never free `Update` before the timer's judgement lands; the Base cell and `hasOutcomeLine` read the same
  presence, so the three readers of the mark agree.
- `autoMergeBlock(pr, repo)`: for a PR that is NOT armed: sync off → `draft` → `not mergeable` (conflicting) → `checks failing` → `auto-merge not enabled on the
  repo`. For a PR that IS armed: sync off only — a person can always disarm what is armed, whatever the PR's state has become. Arming a draft, a conflicting or
  a failing PR is refused because GitHub would not merge it as things stand and the key would lie.

**The why-line** `whyLine(pr, repo, updating, outcomeKind)` is the list of reasons the row writes under its keys: the reasons that come from the REPO or from
the token's permissions — `sync off`, `no merge method allowed`, `auto-merge not enabled on the repo`, `fork does not allow edits`, `no permission to update` —
in key order, each once (a sync-off repo blocks all three keys but the line says `sync off` once). Reasons that are the PR's own facts — `draft`, `not
mergeable`, `checks failing`, `already up to date` — are never on the line, because the row's chips, cells or verdict already draw them or imply them: a row
with no `behind base` chip, `Behind its base.` step or `behind` cell is up to date, and only Matrix's Base cell says so in words. `updating…` joins the line
only while the mark holds AND the row's outcome is not the `updating` one — a later write (`auto-merge armed`, say) replaced it; the row's outcome `kind`
(undefined for none) is the fourth argument — in Inbox and Cards; Matrix's expansion strips that entry, because its Base cell says it. Every reason, line or
not, is on its key as `title` and as a visually-hidden `aria-describedby` span, the `GatedChip` pattern. How the blocks tell a repo reason from a PR fact (a tag
on the reason, or a second table) is the builder's, as long as the line and the keys read the same source.

**Matrix cells** are unchanged. **`columnCounts`** counts facts, not motion: a behind PR whose update is in flight still counts under Base, so the header's
number holds steady from the click to the re-read that shows the branch moved. The cell itself still says `updating…`.

**Layout**: `parseLayout` is unchanged; `drawableLayout` and `layoutOptions(narrow)` go, replaced by one constant list of the three options; the page stops
calling `useNarrow` for the switcher. A stored `matrix` draws Matrix at any width.

**Outcomes**: the mark's three endings become three outcomes. A re-read that no longer lists the PR drops the mark and leaves the outcome to the departed rule,
as today. A re-read that shows a NEW head on the marked PR drops the mark and sets `branch updated` (kind `ok`) whatever outcome the row carries — it is the
latest event, so it replaces an `auto-merge armed` or an `error` set during the mark too — which then lives like `merged` does: until the next write on that PR
leaves. The 30 s timer re-reads FIRST and judges its own re-read by that same rule — a new head is `branch updated`, the same head drops the mark and clears the
`updating` outcome; a re-read that fails is judged "same head", so no mark lingers to turn a much later push into `branch updated`. The timer judges the payload
`refresh` RESOLVES — `load` resolves the fresh `PullRequestsPayload`, null on a failed read, and `refresh` carries it (`Promise<PullRequestsPayload | null>` in
place of today's `Promise<unknown>`) — comparing the marked PR's `headSha` there with the mark's `sha`, never the `data` state, which React has not rendered
when the `await` continues. Today the timer drops the mark and then re-reads; the client's poll is slower than the timer, so the timer's re-read is usually the
first to see the new head, and dropping first would blank #397's common case. This is #397's answer to "how long": the outcome lifecycle, no second timer.

## One key strip, one foot

**`PrActions`** has one variant. It draws the four keys as `Chip size={28}`: the primary one `ink`, the rest `outline`; `Open ↗` is a `Chip as="a"` to `pr.url`
— `Chip` gains `as: 'a'` with `href`, drawn `target=_blank rel=noreferrer` in the outline look — and is never disabled. `Auto-merge` reads `Auto-merge` when
unarmed and `Auto-merge ✓` when armed (the ✓ `aria-hidden`, so the accessible name stays `Auto-merge`), with `pressed` (so `aria-pressed`) following
`pr.autoMerge !== null`; one click sends `enable: true` with `defaultMethod(repo.methods)` (null → no `method` sent) or `enable: false`. `Update` sends the one
update-branch POST. `Merge` opens the row's Confirm — it does not swap the strip, does not change its label. A blocked key is `aria-disabled="true"` with a
click guard — never the `disabled` attribute, which drops it from the tab order and so from a screen reader's reach — with its reason as `title` and in a hidden
`aria-describedby` span, `GatedChip`'s pattern; under the keys, the why-line when `whyLine` is non-empty, one 12 px `--ink2` line, reasons joined by ` · `.
While the row's write is in flight every key but `Open ↗` is `disabled` outright — momentary, with no reason to read — and freed when it lands. A write leaving
the row closes its Confirm — the page's `write` clears the confirming key when it matches — so an in-flight row has no Confirm to accept, and none reopens while
its `Merge` is `disabled`. The method `Select` is no longer in the strip: it lives in the Confirm.

**The foot** is the second shared piece, placed by each layout directly under the row's text at the row's full width (never inside the keys column): the
Confirm, when this row is the confirming one, then `PrOutcomeLine`. The Confirm is `ui/Confirm` with testId `pr-merge-confirm`, as today: its question is
the method `Select` (the repo's allowed methods, `defaultMethod` preselected) followed by `Merge #N into <base>?`; accept `Merge` sends one merge POST with
the picked method; dismiss `Cancel` and Escape close it, nothing sent. The `Select` sits in the Confirm's `children` with the question; `Confirm` itself is
not restyled.

**One confirm on the page.** The key of the row being confirmed is page state beside `outcomes` and `marks`, in `PrLayoutProps`. Opening `Merge` on a second row
closes the first; a second click on the confirming row's own `Merge` is a no-op. A row that leaves the list on a re-read takes its Confirm with it; one on
another row stays. So does a re-read that blocks the confirming row's merge (`mergeBlock` non-null, or its repo's `methods` now empty): the Confirm closes,
nothing sent — the foot draws it only while the row's merge is open. An Inbox tile filter that hides the confirming row closes it too: a row out of the list is
out of the list, whatever took it. In Matrix, closing a row's expansion closes the Confirm in it. A layout switch closes any Confirm. Escape closes the Confirm
and nothing under it — it is the stack's topmost entry while drawn, as today.

**`PrRepoNotes`** keeps its two positions and grows one line kind. Above: the departed outcomes and each sync-off repo's sentence, once per repo. Below: each
truncated repo's `showing N of M`, and now each transient failure's `Can't read · <repo> — <detail>` (`access` when `detail` is null, as Inbox's list does
today), each keeping Inbox's test id `pr-cantread-<repo>` (Matrix's `pr-mfail-<repo>` goes with its row). Inbox's own `Can't read` list and Matrix's muted
failure row both fold into this one home. Cards draws only the below part, and of it only the `Can't read` lines: its card head already says `showing N of M`
and `sync off`, and its departed outcomes stay in the card (see Cards). How the subset is expressed — a prop on `PrRepoNotes`, or a split — is the builder's.

## Inbox

Tiles, the filter, the level order and the `Quiet` heading are unchanged; the `Can't read` heading and its list go, folded into `PrRepoNotes`. A row — loud or
quiet — is: the level dot; the title with `#n` linked and the repo at its end, as today; the fact line (the verdict and its steps for a loud row, `quietFacts`
for a quiet one, no line when there are none); the meta line (today's `author · head → base · age`, plus the run-warning pill); then the foot. A loud row says
the run warning once, as that pill: it calls `prProblems(pr, null)`, so the warning is no longer a calm step (`prProblems` itself is unchanged). The key strip
sits at the row's right, top-aligned with the title; its why-line under it — page text styling in `.prs-why`, a layout-only look the DESIGN guard allows, 12 px
as today but `--ink2` where today's is `--ink3`, so a reason reads without hover. The quiet rows' fold toggle and the compact strip it opened go — a quiet row
carries the same four keys, always drawn, and its `#n` link is a link and nothing more.

Below the board's narrow breakpoint (`NARROW_QUERY`, 700 px) the key strip wraps under the meta line at full width and the why-line follows it. Above
it the row keeps today's content-driven wrap — the text block's `flex: 1 1 320px` basis — so the strip drops under the meta line whenever the title would
get less than 320 px; the title is never squeezed to make room for keys.

## Matrix

The columns, cells, tones, the legend, the dot, the sort and the row toggle (click, Enter, Space; the `#n` link and the expansion excluded) are unchanged.

**The expansion** is one tinted block: the PR row and the expansion row share `--strip-hi` and the inset ink bar (which rides the pinned block in the expansion
row, so it stays in view while the table is scrolled), and the expansion holds the key strip with its why-line, then the foot. An outcome on an OPEN row is
drawn inside the expansion, last; no `prs-matrix-outcome` row is drawn for that PR while it is open. An outcome on a COLLAPSED row keeps today's own row
directly under the PR row.

**`updating…` once.** A Matrix row in motion says it in the Base cell, and only there: an `updating` outcome draws no outcome row in Matrix, collapsed or
open (the key is still disabled with `updating…` as its reason). `branch updated`, `merged`, the auto-merge answers and every error draw as outcomes.

**The header's count** holds while a row updates (`columnCounts` above).

**Repos that could not be read** are no longer rows. Their PRs from the last good read stay ranked in the table; the failure is one `Can't read` line below
the table, from `PrRepoNotes`. When no shown repo has a PR and some shown repo could not be read, the page draws neither the table nor `no open pull
requests`, and no legend — only the notes, as Inbox already does.

**Width.** The table sits in a box that scrolls sideways when the pane is narrower than its columns' sum; the table keeps its columns' natural widths rather
than squeezing them. The dot and PR cells are sticky at the box's left edge, carrying their row's ground — plain, hover `--strip-hi`, or the open row's
`--strip-hi` with the ink bar — so cells scrolling under them never show through. `ui/Ledger` without `columns` is already such a box (`overflow-x: auto`), but
the pinned widths below need the box as a container and the DESIGN guard forbids a page rule on `.ui-ledger`, so Matrix wraps its table in a
`.prs-matrix-scroll` of its own (`overflow-x: auto; container-type: inline-size`). The `Segmented` offers Matrix at every width. The expansion's block (keys,
why-line, foot) and a collapsed row's outcome row are each one cell spanning every column; their content is pinned to the box's visible width — sticky at the
box's left edge and as wide as the box (`100cqw` with the box as an inline-size container, or a measured width; builder's) — so `Merge`, `Cancel` and the
outcome text never sit off-screen while the table is scrolled. The PR column drops today's `width: 100%` — the table is `max-content` wide with a `100 %`
minimum, so the column takes the slack on a wide pane — and its 200 px minimum yields to one cap: the dot and PR cells together take at most 60 % of the box's
width (`max-width: 60cqw` on a block inside the PR cell — never on the `<td>`, where CSS leaves `max-width` undefined and Chrome ignores it — or the measured
equivalent), the title wrapping there instead of ellipsizing, so a 375 px phone (a box of about 299 px) keeps about 120 px of evidence cells in view.

## Cards

A card per repo that holds at least one open PR, in `groupRepos` order; a repo whose last read was ok and lists none is not drawn, and the toolbar says how
many: `N repos with no open PRs` (`1 repo with no open PRs`), a second `prs-toolbar-note` after the hidden-repos note (or in its place) and before the polled
age, in Cards only — Inbox and Matrix never drew repos. The count is of repos NOT drawn: a card kept for a departed outcome is drawn, so not counted, and a repo
not yet read (`polledAt` null, no rows) is neither drawn nor counted — unknown is not empty. A repo that could not be read and holds no rows is a `Can't read`
line below the cards, not a sheet; one that still holds rows from an earlier read keeps its card and gets the line. When no card is drawn, Cards says `no open
pull requests` under the condition Inbox and Matrix use — every shown repo read cleanly — and otherwise only the notes; a count of 0 draws no `repos with no
open PRs` note. A sync-off repo that lists none is not drawn either, so its `sync off` is said nowhere — harmless, it holds nothing to act on. A repo whose last
PR has just left (merged, closed) keeps its card for as long as that departed outcome lives, with the outcome as the card's only line under the head (no `no
open pull requests`), so `#12 merged` stays where the row was; the card's own departed lines are today's.

A card's row is: the title with `#n` linked; the meta line; the chips (the run-warning `Pill` among them, as today); the key strip at the right with its
why-line; then the foot under the text at the row's full width. The card's head keeps the repo, `polled N ago`, `showing N of M` and the `sync off` pill with
its sentence; its red `detail` line goes — the `Can't read` line below says it once. The narrow wrap rule is Inbox's.

## Docs

- `.claude/DESIGN.md` §8.11: rewrite "The toolbar and the layout switch" (Matrix at every width; the no-open-PRs note), "Hidden repos and the empty states",
  "Inbox", "Compact keys" (becomes "The key strip"), "Matrix", "Cards", "What every layout carries", "Grouping (Cards)", "The repo heading (Cards)", "Row
  anatomy (Cards)", "Actions and their reasons" (the why-line rule and the `aria-disabled` + title + `aria-describedby` pattern), "The outcome line", "The
  warning chip" (the Inbox meta-line pill) and "`updating…`" (Matrix's Base-cell exception, `branch updated`).
- `2026-10-29-prs-layouts-design.md`: one line under its title naming this spec as superseding the sections above; the body is history and stays.
- `.claude/rules/board.md`, the Escape-stack bullet: GitHub › PRs' `Merge` Confirm is opened by `PrActions` and drawn by the foot, not `PrRow`
  (`test/claude-rules.test.ts` keeps the headline; the mechanism sentence changes).
- `docs/subsystems/board.md`: the PRs-page paragraph (today's lines 481–507: the narrow Matrix gate, the compact keys and `Merge…`, the Quiet row's
  `Actions` toggle, the Cards head, `PrRow`'s strip with its method `Select`, the `(<method>)?` Confirm, Enable/Disable auto-merge, `Update branch`,
  "never a tooltip alone" and the timer order), rewritten whole; the `Chip` row of the primitives table (line 98, `as?: button|label|a`); and the `lib/`
  paragraph (lines 673–677) that names `compactKeys`.
- Issue #397: closed by the PR, named in its body.

## Tests (cases, not code)

The suites are the ones that exist; cases named here replace or join the ones there. Fixture dates stay relative to the clock the assertion runs under.

- `test/prs-lib.test.ts` — `updateBlock`: behind + updatable + mark → `updating…`; behind + not updatable + mark → `updating…` (motion beats permission); not
  behind + not updatable, no mark → `already up to date`; clean + updatable, no mark → null; sync off beats the mark. `autoMergeBlock`, unarmed: sync off, then
  draft, then conflicting, then failing, then the repo setting, first match wins; armed: a failing, conflicting or draft PR on a repo whose setting is off →
  null. `whyLine`: sync-off repo → exactly `['sync off']`; quiet PR, repo without auto-merge → `['auto-merge not enabled on the repo']`; repo with no allowed
  method and no auto-merge → both, merge's first; fork without edits → `['fork does not allow edits']`; behind + not updatable, own repo → `['no permission to
  update']`; failing checks on a clean repo → `[]`; a PR with the mark → `[]`.
- `test/pr-layouts-lib.test.ts` — `primaryKey`: every `compactKeys` primary case today, renamed, plus behind + mark → null. `columnCounts`: two behind
  rows, one with the mark → `base: 2`. Layout: `parseLayout` cases stand; the `drawableLayout` and `layoutOptions` cases go; the options constant has
  three entries, inbox, matrix, cards, in that order.
- `test/prs-actions.test.tsx` (rendering `PrActions` and the foot through a small harness that holds the confirming key in state, as the page does) — four keys
  in order by accessible name `Merge`, `Auto-merge`, `Update`, `Open ↗`; `Open ↗` is an `<a>` to `pr.url` with `target=_blank`; the primary is `ui-chip-ink`,
  the others `ui-chip-outline`, none ink when there is no primary; `Merge` opens `pr-merge-confirm` holding a `Select` of the repo's methods and the text `Merge
  #5 into main?`, accept POSTs once with the picked method, dismiss POSTs nothing, Escape dismisses; failing checks → `Merge` `aria-disabled`, `title` `checks
  failing`, `aria-describedby` resolves to that text, no why-line, click opens nothing; repo without auto-merge → why-line `auto-merge not enabled on the repo`,
  `Auto-merge` `aria-disabled`; sync off → three keys `aria-disabled`, why-line reads `sync off` once, `Open ↗` still a link; unarmed `Auto-merge` has
  `aria-pressed=false` and sends `enable: true` with the default method; armed reads `Auto-merge ✓`, `aria-pressed=true`, sends `enable: false`, and is enabled
  on a failing PR; `Update` on a behind PR sends one update POST, and is `aria-disabled` with `title` `updating…` while the mark holds; in flight sets
  `disabled` on all but `Open ↗` and lands free; with the Confirm open, clicking `Auto-merge` leaves no `pr-merge-confirm` and sends one auto-merge POST and no
  merge POST; a second click on `Merge` while its Confirm is open leaves that one Confirm.
- `test/prs-inbox.test.tsx` — a loud and a quiet row each carry the four keys, and the quiet row has no toggle (`#n` is a link, no `aria-expanded` anywhere); a
  why-line only on rows with a repo reason; a row with the mark and an `auto-merge armed` outcome reads `updating…` on its why-line and `auto-merge armed` on
  its outcome line, and with the `updating` outcome its why-line is empty; a loud row under a live run draws the warning as one pill on its meta line and not as
  a step, and its meta line reads `author · head → base · age`; opening `Merge` on a second row leaves one `pr-merge-confirm` on the page, on the second row;
  the Confirm sits in the row's foot under the text, found `within` the row and not within the keys column; the a/x#7-leaves-a/y#7-stays case stands; an outcome
  line under a loud and under a quiet row; departed outcomes above, `Can't read` and truncated lines below, from `PrRepoNotes`; a sync-off repo's sentence once
  above and `sync off` on each of its rows' why-lines.
- `test/prs-matrix.test.tsx` — the expansion holds the four keys and the why-line; an ok outcome on an OPEN row is inside `prs-matrix-expand` and no
  `prs-matrix-outcome` row exists for it; the same outcome on the collapsed row is one `prs-matrix-outcome` row; an `updating` outcome draws no row either way,
  the Base cell reads `updating…`, and the expansion's `Update` is `aria-disabled` with `title` `updating…`; `branch updated` draws as a row; Base header reads
  2 with two behind rows, one marked; a rate-limited repo with rows keeps its rows and has no muted row, and the `Can't read` line is below the table; a
  rate-limited repo without rows is a line only; the only shown repo failed and holds nothing → no table, no empty sentence, the line; the table is inside the
  scroll box, the dot and PR cells carry the sticky class, and the expansion block and the outcome row carry the pinned class; closing an expansion with a
  Confirm open leaves no `pr-merge-confirm`; every toggle, link and key case today stands.
- `test/prs-view.test.tsx` — every shown repo read clean and listing nothing → Cards draws `no open pull requests` and no count note; a stored `matrix` draws
  Matrix on a narrow window and the switcher offers three options (replacing the narrow-as-Inbox case); Cards draws no `pr-repo-*` for an ok repo with no PRs
  and the toolbar reads `1 repo with no open PRs` (then `2 repos …`); a rate-limited repo without rows has no `pr-repo-*` and a `Can't read` line; a repo whose
  only PR departed keeps its `pr-repo-*` with `#12 merged` inside, and Cards draws no departed line and no `showing N of M` from `PrRepoNotes`; the merge,
  method, 409 and 502 cases stand with the `Select` now inside `pr-merge-confirm`; `says why each blocked action is disabled, beside it` becomes two cases: a
  PR-fact reason on the key's `title` and `aria-describedby`, a repo reason on the why-line; the armed case reads `Auto-merge ✓` and sends `enable: false`; a
  re-read with a new head while the mark holds → `pr-outcome` reads `branch updated` and still does after the 30 s would have passed; the 30 s timer's own
  re-read showing a new head → `branch updated` (the mark is dropped after that re-read, not before); the same-head 30 s case stands; the layout-switch cases
  for marks and in-flight stand, plus: a layout switch closes an open Confirm, and a re-read that turns the confirming PR's checks to `failure` closes it too,
  nothing sent.
- `test/claude-rules.test.ts` and the CSP, proxy and DESIGN guards run as they are; `test/ui-chip.test.tsx` gains the anchor case: `as="a"` with `href`
  renders an `<a>` carrying the chip classes, `target=_blank` and `rel=noreferrer`.
- Source guards to add to the scoped CI run, by `grep -l <symbol> test/` — run on 2026-10-30: `PrActions` → prs-actions; `PrInbox` → prs-inbox; `PrMatrix` →
  prs-matrix; `PullRequestsView` → run-pulse, prs-view, source-sections; `usePullRequests` → github-settings, use-pull-requests; `compactKeys` → pr-layouts-lib;
  `drawableLayout` → pr-layouts-lib; `layoutOptions` → pr-layouts-lib; `PrOutcomeLine` → prs-actions; `useNarrow` → jira-chip, prs-view, rail, releases-drawer,
  shell-strip, tracker-chip, ui-form-sheet, ui-popover, ui-modal, ui-use-narrow; `useDialogEscape` → dialog-count-docs, dialog-escape, orchestrator-start-ui,
  runs-view, prs-matrix, run-controls, tracker-chip, ui-popover, ui-modal; `PrRow`, `PrCards` and `PrRepoNotes` match no suite today, and `Confirm` matches
  every suite that spells the word, so the builder reruns the grep for the symbols the diff adds callers of and takes the hits, not this list.

## Left to the builder

File split in `components/github/` (whether the foot is its own component or a part of each layout's row); the names `primaryKey`, `whyLine`, the options
constant, the sticky and scroll class names (`.prs-*` for layout only, every look a `ui/` primitive's); the exact `Can't read` line punctuation; the Confirm's
accessible label; the order of CSS edits in `styles.css`'s `.prs-*` block; the plan's task order and size.

## Calls made by the author, not the user

The user decided: the fixed four keys and their order; a disabled key stays in place, greyed; one why-line per row with only the reasons the row does not
already state, plus `title` and `aria-describedby` on every blocked key; `Auto-merge` as a toggle reading `Auto-merge ✓`; the inline Confirm under the row;
Cards with the same four keys; Matrix at every width by horizontal scroll. These the author decided and the user should check:

- An ARMED PR can always be disarmed: the new draft / conflicting / failing refusals apply to arming only.
- The why-line carries repo and permission reasons; PR facts are tooltip-and-aria only, and `updating…` joins the line only once a later write's outcome has
  replaced the `updating` one (never in Matrix, whose Base cell says it). `already up to date` counts as a PR fact, implied by the absence of `behind base`
  rather than written on nearly every row.
- In Matrix the Base cell is the one place a row says `updating…`; the `updating` outcome draws no row there. Inbox and Cards, which have no cell, draw
  the `updating…` outcome line.
- The Base header's count ignores the mark: a PR being updated still counts as behind until the re-read says otherwise.
- `branch updated` lives until the next write on that PR, like `merged`; no second timer.
- The confirming row's key is page state, one Confirm per page; a layout switch closes it.
- Quiet Inbox rows lose their fold toggle and carry the four keys like every other row.
- The method `Select` moves into the Confirm; the strip is keys only, so arming auto-merge always sends the repo's default method.
- Cards' empty-repo count wording: `N repos with no open PRs`.
- `Update` is the key's whole label (not `Update branch`), matching the mock the user picked.
- The 30 s timer re-reads before it drops the mark, so its own re-read can end in `branch updated`; today's order would blank the common case.
- Cards keeps its departed lines and its head's sentences; `PrRepoNotes` in Cards is the `Can't read` lines only, below. A repo whose last PR departed
  keeps its card while that outcome lives.
- In Matrix's scroll box the expansion block and the outcome row are pinned to the visible width.
- A loud Inbox row says the run warning once, as the meta-line pill, not as a calm step; the meta line keeps today's author.
- A repo reason (`sync off`, `auto-merge not enabled on the repo`) repeats on every row of that repo's why-line: the fixed four keys the user picked make
  the key present on every row, and a present blocked key owes its reason.
- A quiet Inbox row gains a meta line (today it is one line with the warning pill inline), so every row has one anatomy.
- `branch updated` is the latest event: it replaces whatever outcome the row carries, `auto-merge armed` included; a failed timer re-read counts as the
  same head.
- `updateBlock`'s `updating` argument is the mark's presence, never the page clock, so `Update` frees only when the timer judges.
- Matrix's scroll box is page-owned (`.prs-matrix-scroll`), not `ui/Ledger`, because the pinned widths need it as a container and the DESIGN guard
  forbids a page rule on `.ui-ledger`.
- A repo not yet read is neither a card nor counted as empty; a card kept for a departed outcome is drawn, so not counted either.
- A tile filter that hides the confirming row closes its Confirm, like a re-read that drops the row.
- The Cards head's red `detail` line goes; `Can't read` below the cards says it once.
