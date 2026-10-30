# Review — `2026-10-30-prs-page-fixes-design.md`, round 1

Document: `docs/superpowers/specs/2026-10-30-prs-page-fixes-design.md` (251 lines). Kind: spec. Reviewed against the tree at `4060b76d` (main).
Line numbers `doc:N` are the spec's; every claim about the code cites the file and line it was checked at.

## Verdict: REVISE

One Critical: the rewritten `updateBlock` ladder, read as written and pinned by its own test case, disables `Update` with a false reason on PRs GitHub says
can be updated. Eight Important findings, mostly places where the spec states a fact the code contradicts (Chip has no `as="a"`, the `N open` count is not
in the toolbar, the GatedChip pattern is not `disabled`) or leaves the builder to guess (the Docs list misses five DESIGN paragraphs and most of the
board.md sentences it must rewrite; Matrix's sticky geometry at phone width; an open Confirm whose PR becomes merge-blocked). None needs a new idea — each
fix is a sentence or two.

## Critical

### C1 — `updateBlock`'s last rung drops the `!canUpdateBranch` condition (doc:63-64, doc:179-180)

The spec's ladder: sync off → `updating…` → fork does not allow edits → `no permission to update` "when behind and not updatable" →
`already up to date` "when not behind". The last rung has no condition on `canUpdateBranch`. Today's code puts BOTH words under `!pr.canUpdateBranch`
(`client/src/lib/prs.ts:78`: `if (!pr.canUpdateBranch) return pr.mergeState === 'behind' ? 'no permission to update' : 'already up to date'; return null;`),
and the comment above it (`prs.ts:71-73`) is explicit that `mergeState` only tells the two apart once GitHub has said the branch cannot be updated.

The spec's test case pins the wrong reading: "not behind, no mark → `already up to date`" (doc:180). The prs-lib fixture defaults to
`mergeState: 'clean'`, `canUpdateBranch: true`, so that case asserts `already up to date` for a PR GitHub says IS updatable — today
`updateBlock(pr({ crossRepository: true, maintainerCanModify: true }), repo())` is `null` (`test/prs-lib.test.ts:103`).

Why it matters: `mergeStateStatus` reports `BEHIND` only under strict branch protection. On a repo without "require branches to be up to date", a PR whose
base has moved reads `clean` or `blocked` while `viewerCanUpdateBranch` is true. Built as written, `Update` — now drawn on every row (doc:21) — is greyed
with `already up to date` on exactly those PRs, and the one key that would bring them up to date is gone. The spec's own `primaryKey` (doc:56) still keys on
"behind", so it is unaffected; the regression is the block.

Fix: keep both reasons under `!canUpdateBranch` — "… → `no permission to update` when not updatable and behind → `already up to date` when not updatable
and not behind; otherwise null" — and write the test as "not behind, not updatable (`canUpdateBranch: false`), no mark → `already up to date`", plus the
existing "`clean` + updatable → null" case (`prs-lib.test.ts:103`) kept explicitly.

## Important

### I1 — `Open ↗` as `Chip as="a"` does not exist (doc:92, doc:188, doc:218)

`Chip`'s `as` is `'button' | 'label'` (`client/src/components/ui/Chip.tsx:36`); there is no `href`/`target`/`rel` prop, and its pass-through is limited to
`data-*`/`aria-*`. `docs/subsystems/board.md:98` documents that API. So doc:92 requires a `ui/Chip` change, yet doc:218 says `test/ui-chip.test.tsx`
"gains a case only if `Chip` changes (a look for `pressed`, say)", and "Left to the builder" (doc:225-228) does not mention widening `Chip`. The `rel` of
the new-tab link is also unspecified (today's `#n` links open "in a new tab with no referrer", `.claude/DESIGN.md:556`).

Fix: either name the change — `Chip` gains `as: 'a'` with `href`, `target`, `rel` (`noreferrer`), a `ui-chip` test case, the board.md:98 table row and a
DESIGN §8 line — or draw `Open ↗` as a plain `<a>` carrying the chip classes through a ui primitive that already exists. Say which, and state `rel`.

### I2 — "the `GatedChip` pattern" is `aria-disabled`, not `disabled` (doc:73-74, doc:95, doc:191, doc:194-195)

doc:73-74 says every blocked key carries its reason "as `title` and as a visually-hidden `aria-describedby` span, the `GatedChip` pattern", and Goal
doc:22 says the reason is "reachable … by screen reader on the key". doc:95 then makes a blocked key `disabled`, and the tests assert `disabled`
(doc:191, doc:194). `GatedChip` deliberately does NOT use `disabled`: `client/src/components/ui/GatedChip.tsx:69-75` explains that a `disabled` button
leaves the tab order, so a keyboard or screen-reader user cannot reach the `aria-describedby` reason at all, and it uses `aria-disabled` plus an `onClick`
guard instead. With `disabled`, a PR-fact reason (which, per doc:71-72, is NOT on the why-line) is reachable only by mouse hover — the anti-goal at doc:41.

Fix: pick one. Either "a blocked key is `aria-disabled` with a click guard, the `GatedChip` pattern" and tests that assert `aria-disabled="true"` and that a
click sends nothing; or keep `disabled` and drop the `GatedChip` claim and the screen-reader half of Goal doc:22.

### I3 — `already up to date` is not "already drawn" in Inbox or Cards (doc:71-72, doc:41, doc:237)

doc:71-72 keeps PR-fact reasons off the why-line "because the row's chips, cells or verdict already draw them", and lists `already up to date` among them.
In Matrix the Base cell does say `up to date` (`client/src/lib/pr-layouts.ts:293`, `matrixCells`). In Inbox and Cards nothing does: the chip vocabulary
(`prChips`, also Inbox's `quietFacts`, `pr-layouts.ts:126`) has `behind base` for a behind PR and no word at all for one that is not, and the verdict
(`prProblems`) names problems only. Since `Update` is now drawn on every PR (doc:21) where today Inbox offered it only when behind (`pr-layouts.ts:255`),
most Inbox and Cards rows will carry a greyed `Update` whose reason exists only as `title` — doc:41's anti-goal ("a reason for a blocked key that exists only
on hover … a phone has no hover"), compounded by I2.

Fix: either put `already up to date` on the why-line in Inbox and Cards (the layouts with no Base cell), or keep it off and amend doc:41 / doc:72 to say
the absence of a `behind base` chip is the statement — and list that under doc:237 so the user checks it knowingly.

### I4 — the `N open` count is not in the toolbar (doc:153-154)

"the toolbar says how many: `N repos with no open PRs` … after the open count". The open count is a `Pill` in the `Band`
(`client/src/components/github/PullRequestsView.tsx:182`), not in the toolbar; the toolbar row (`PullRequestsView.tsx:201-221`) is the `Segmented`, the
hidden-repo note and `PolledAge` (`.claude/DESIGN.md:538`). "After the open count" therefore puts it in the band, while "the toolbar says" puts it under it.

Fix: name one place — e.g. "in the toolbar, after the hidden-repo note and before `polled N ago`", or "in the band, a second neutral pill after `N open`" —
and its look (plain text, or a `Pill` tone).

### I5 — the DESIGN.md Docs list misses five §8.11 paragraphs this spec contradicts (doc:165-167)

The list names "Inbox", "Compact keys", "Matrix", "Cards", "What every layout carries", "Actions and their reasons", "The outcome line" and "`updating…`".
These paragraphs also state behaviour the spec changes and are not listed:

- "The toolbar and the layout switch" (`.claude/DESIGN.md:538`): "Matrix is wide-only … `drawableLayout` … `layoutOptions`" — reversed by doc:26 and
  doc:80-81.
- "Hidden repos and the empty states" (`DESIGN.md:540`): "(Cards keeps its per-repo line)" for a failed repo — replaced by doc:155's `Can't read` line.
- "Grouping (Cards)" (`DESIGN.md:552`): "then the empty ones by name" — empty repos are no longer drawn (doc:153).
- "The repo heading (Cards)" (`DESIGN.md:554`): `no open pull requests` in the sub, and "a repo whose last read was not `ok` puts its `detail` … in `--red`"
  — a repo with no PRs is not drawn, and the failure is now the `Can't read` line (see also Minor m11).
- "Row anatomy (Cards)" (`DESIGN.md:556`): "the chips; the actions; the outcome line" — the keys move to the right with a why-line and the foot (doc:159-160).

Fix: add the five, with one clause each saying what changes.

### I6 — the board.md grep does not find the sentences it is meant to find (doc:171-172)

`grep -n -E "compact|Merge…|variant|drawableLayout|narrow" docs/subsystems/board.md` matches lines 488 and 490 of the PRs paragraph, but not
`docs/subsystems/board.md:493-501`, which carry: the Cards head's `no open pull requests` and the failed read's `detail`; "A row (`PrRow`)"; "a method
`Select` … `Merge` behind an inline `Confirm` (`Merge #<n> into <base> (<method>)?`), `Enable`/`Disable auto-merge` and `Update branch`"; and "a blocked one
is disabled with its reason … in text beside it … never a tooltip alone"; and `board.md:505-507`, where the 30 s timer "re-reads" after the mark ends —
the order doc:85-87 reverses. Every one of those changes under this spec. It also misses the Chip API row
(`board.md:98`, if I1 widens `Chip`) and the `PrRow` / `compactKeys` names in the lib map (`board.md:673`, `board.md:677`). Conversely it matches a dozen
unrelated lines (`board.md:35`, `46`, `89`, `150`, `220-222`, `258`, `449`, `582`, `647`, `666` …), so it is a poor stand-in for a list.

Fix: name the paragraph ("the GitHub › PRs paragraph, `board.md:481-507`, rewritten whole") and the two other lines (`board.md:98`, `board.md:673-677`)
instead of a grep.

### I7 — Matrix's sticky PR column at phone width leaves almost no room to scroll (doc:143-149, doc:26)

At 375 px the Ledger box is about 299 px wide: 375 − 2 × 14 px `--body-pad` on a phone (`client/src/styles.css:63`) − 2 × 24 px `ui-sheet` padding
(`styles.css:3095`). The sticky part is the dot cell (10 px + 12 + 12 px padding, `styles.css:3028`) plus the PR cell, whose `min-width` is 200 px before
its own padding (`styles.css:3035`) — roughly 240-250 px pinned, leaving ~50 px through which six evidence columns scroll. Worse, the PR column today is
`width: 100%` (`styles.css:3035`, "the PR column taking the spare width", `DESIGN.md:546`); in a box that is told to keep natural widths, a sticky column
that takes the spare width can claim the whole visible box. doc:143-144 says the table "keeps its columns' natural widths" without saying what the PR
column's natural width is once it is sticky.

Fix: state the PR column's width rule inside the scroll box (e.g. a fixed or `min()`-capped width below `NARROW_QUERY`, or "not sticky below 700 px,
only the dot"), and add the matching `prs-matrix` test or a DESIGN line so the builder does not pick it by eye.

### I8 — an open Confirm whose PR becomes merge-blocked is not covered (doc:105-108)

doc:105-108 lists what closes the Confirm: a second row's `Merge`, the row leaving the list, collapsing the Matrix expansion, a layout switch, Escape. It
does not say what happens when a re-read (the 60 s poll, another row's write, the 30 s timer) turns `mergeBlock` non-null while the Confirm is open —
checks start failing, the repo's sync goes off, or `methods` comes back empty. Today the Confirm is drawn only while `method !== null`
(`client/src/components/github/PrActions.tsx:154`), so an empty `methods` hides it; under doc:100-102 the Confirm owns the method `Select` and nothing says
it hides. As written, accept would still POST a merge for a PR the strip beside it now marks blocked (the server refuses only `sync off`; a
non-required failing check is merged by GitHub).

Fix: one sentence — "the Confirm closes when `mergeBlock` for its row becomes non-null" (or "accept is disabled with the block as its reason") — and a
test case for it.

## Minor

- **m1 — superseded-section names (doc:3-5).** The 10-29 spec has no "Compact keys" section; it is a bold run-in inside its Inbox section
  (`2026-10-29-prs-layouts-design.md:115`). Its "Layout key" section (`2026-10-29-prs-layouts-design.md:91-95`), which carries the Matrix wide-only rule
  doc:26 reverses, is not listed, and doc:4 says what this spec "does not touch still holds". Add "Layout key" to the list.
- **m2 — Data is not "Unchanged" (doc:48-49, doc:105).** `PrLayoutProps` today is `{repos, outcomes, marks, now, ctx, write, inFlight}`
  (`PullRequestsView.tsx`); `markUpdating` and `dropMark` are page-local and not handed down. And doc:105 adds the confirming row's key to `PrLayoutProps`.
  Say "`PrLayoutProps` gains the confirming key and its setter".
- **m3 — repo reasons now repeat down the page (doc:13-14 vs doc:69-71, doc:200-201).** The intent faults Cards for "the same disabled reasons repeated
  down the page"; with four fixed keys, `auto-merge not enabled on the repo` (GitHub's `allow_auto_merge` is off by default) and `sync off` land on every
  row's why-line of such a repo — and doc:200-201 tests exactly that for `sync off`. The user picked the four fixed keys, so this is the author's to state
  rather than fix: say under doc:237 that a repo reason is repeated per row by design.
- **m4 — `branch updated` "replaces the `updating` outcome" when there is none (doc:83-85).** After the update lands, `Auto-merge` is free (doc:96-97), so a
  person can arm it during the mark; the row's outcome is then `auto-merge armed`, and a later new head finds no `updating` outcome to replace. Say whether
  `branch updated` is set only while the outcome is still `updating`, or always.
- **m5 — the timer's re-read can fail, and the clock can free `Update` before it lands (doc:85-86).** `refresh` resolves whatever happened; say that a
  failed re-read is judged "same head" (mark dropped, `updating` cleared), so a mark can never linger and turn a much later push into `branch updated`.
  Also, `isUpdating` is `now < mark.until` (`prs.ts:105-107`) on a 15 s page clock, so `updateBlock`'s `updating…` rung can lapse — and `Update` re-enable
  — during the timer's in-flight re-read; say whether the rung reads the mark's presence or `isUpdating`.
- **m6 — `Auto-merge ✓`'s accessible name (doc:93, doc:193).** The ✓ is read aloud ("Auto-merge check mark") while `aria-pressed` already says the state;
  doc:188 asserts names `Merge`, `Auto-merge`, `Update`, `Open ↗`. Mark the ✓ `aria-hidden` so the name is stable, or assert the armed name explicitly.
- **m7 — the 700 px wrap rule versus "the title is never squeezed" (doc:123-124).** Between 701 px and roughly 900 px, with the 240 px rail, a four-key
  strip beside the title leaves the title less room than today's content-driven wrap (`.prs-inbox-main { flex: 1 1 320px }`), which wraps whenever the
  title would drop under 320 px. Either keep the flex-basis wrap or state the minimum title width.
- **m8 — the Matrix legend with no table (doc:139-141).** When only the notes are drawn, say whether `pr-matrix-legend` is drawn.
- **m9 — `100cqw` needs a `.prs-*` container (doc:146-148).** Guard 7 checks every class token of every selector outside the ui block
  (`test/design-guards.test.ts`, "no selector outside the block starts with a family name"), so `container-type` cannot be set on `.ui-ledger` from the page,
  not even as `.prs-matrix .ui-ledger`. The container must be a `.prs-*` wrapper the Ledger fills; say so, since doc:145-146 suggests the Ledger itself.
- **m10 — Cards' "ok and lists none" edge cases (doc:153-157).** (a) Does a card kept only for a departed outcome count in `N repos with no open PRs`?
  (b) Does its head still read `no open pull requests` (`PrCards.tsx:31`) under `#12 merged`? (c) An `ok` repo not yet read has `polledAt: null` and no
  rows (`server/src/tracker/pulls.service.ts:488-506`, `entryOf`/`view`); is it counted as "no open PRs" before its first read?
- **m11 — Cards' head `detail` line duplicates the new `Can't read` line (doc:155-156, doc:160).** A failed repo that keeps its card still draws its
  `detail` in `--red` under the head (`PrCards.tsx:51`, `DESIGN.md:554`) and now also gets the `Can't read` line below. doc:160 lists what the head keeps
  and omits the detail; say it goes.
- **m12 — the run warning's place in a Cards row (doc:159-160).** The row is "title; meta line; chips; key strip"; the warning is a `Pill` among the chips
  today (`DESIGN.md:558`). Say it stays with the chips (Inbox moves it to the meta line, doc:118-119).
- **m13 — `prs-actions.test` cannot open the Confirm on its own (doc:188-190).** The confirming key is now page state (doc:105); `PrActions` rendered
  alone needs a harness holding that state. Say the suite renders through one (or move the Confirm cases to `prs-view`).
- **m14 — quiet Inbox rows gain a meta line (doc:117-118).** Today a quiet row is one line with the warning `Pill` inline (`PrInbox.tsx:134`); the new row
  anatomy gives it a fact line and a meta line. That is a visible change worth one sentence under doc:243.
- **m15 — "every look a `ui/` primitive's" versus the why-line (doc:226, doc:96).** The why-line's 12 px `--ink2` look is a page-drawn look in `.prs-*`
  (today's `.prs-why` is 12 px `--ink3`, `DESIGN.md:560`); either it is layout-only text styling the guard allows, or it belongs in `components/ui/`. One
  clause settles it — and note the colour change from `--ink3`.
- **m16 — "three level headings" (doc:117).** Inbox has two `h3`s, `Quiet` and `Can't read` (`PrInbox.tsx:202`, `PrInbox.tsx:214`); loud items carry no
  level heading, and doc:111 moves `Can't read` into `PrRepoNotes`. "Unchanged" makes the slip harmless, but the sentence should say what is there.
- **m17 — the `Can't read` line's fallback (doc:111).** Today Inbox draws `${repo.repo} — ${repo.detail ?? repo.access}` (`PrInbox.tsx:218`); the spec's
  `Can't read · <repo> — <detail>` has no fallback for a null `detail`. Keep `?? access`.
- **m18 — a confirming row hidden by the Inbox tile filter (doc:105).** A tile click can filter the confirming row out of the list while its page-state key
  survives, so the Confirm reappears when the filter clears. Say whether a filter change closes it.
- **m19 — source guards (doc:220-221).** `PrRow` matches no file in `test/` today, so it adds nothing to the scoped run; harmless, but the list reads as
  checked. Run the `grep -l` once and list the hits.

## Checked and found sound

- The four write paths and their shapes are untouched (doc:33-34); `PR_UPDATING_MS` is 30 s in `shared/types.ts`.
- `mergeBlock`'s order (doc:62) matches `prs.ts:61-68`; `autoMergeBlock`'s armed exception (doc:66) keeps today's disarm path (`prs.ts:86-90`).
- `primaryKey` (doc:55-58) is `compactKeys`' primary rule (`pr-layouts.ts:253-262`) plus the mark case; the draft-behind-qualifies rule carries over.
- The Confirm testId `pr-merge-confirm` exists today (`PrActions.tsx:159`); `ui/Confirm` joins the Escape stack via `useDialogEscape`, so doc:107-108's
  Escape claim holds once the Confirm is unmounted with its row.
- `columnCounts` (doc:77-78) today takes the `updating` set (`pr-layouts.ts:329-336`); dropping it is the stated change and the test at doc:185-186 pins it.
- Issue #397 is open and asks how long the line should show; doc:85-88 answers it.
- Every test suite named in doc:179-219 exists, and fixture dates are relative as `.claude/rules/tests.md` requires (doc:177).
