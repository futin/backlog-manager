# Review 1 — Jira board: children fold into their top ancestor (2026-10-16)

Document: `docs/superpowers/specs/2026-10-16-jira-grouped-board-design.md`. Reviewer: Fable 5.1, fresh session, paths and checklist only. Every claim
below was checked against the code on `feat/jira-grouped-board` (HEAD `d51f0d0`) and against the three picked mocks read from the linked canvas
(`GroupTop.dc.html`, `ModalChildren.dc.html`, `GroupFilter.dc.html`).

**Verdict: REVISE** — one Critical (a CSS token the repo does not have, cited as an existing one), eight Important.

## Critical

- **[C] spec:54 — `--green2` does not exist, and the three Jira column dots are not three tokens.** `shared/theme.css` and `client/src/styles.css` name
  no `--green2` (grep: zero hits); the progress bar's done segment would reference an undefined variable and paint nothing. The "three column dots'
  tokens" claim is the MOCK's (`GroupTop.dc.html` colours its dots `--ink3` / `--amber` / `--green2` from its own `jira.css`), not the repo's: `todo`,
  `doing` and `done` are outside `RAMP_SLUGS`, so each header draws the plain `<Dot />` (`client/src/components/board/BoardColumn.tsx:80`), which is
  `--ink3` for all three (`styles.css:2846`; DESIGN.md §8.9.1 "Columns" says so in words). → Name the repo's tokens and drop the dots as the source:
  done = `--green-solid` (or `--fill-progress`, which `.ui-dot-done` reads, `styles.css:2851`), in progress = `--amber-solid` (or `--fill-live`), to do =
  `--ink3`. `theme.css:73` is explicit that a mark reads the `-solid` split, never bare `--amber`.

## Important

- **[I] spec:30–32 with spec:114 — a cycle has no top under the stated rule.** "Top = `parent` null or `parent.key` not loaded" gives no top for a
  self-parent (`parent.key === key`, which IS in the list) or a two-cycle, yet §9 requires "each issue appears exactly once" and §1 that nothing becomes
  unreachable. The walk's "stops at a key it has seen" says it terminates, not where the issue lands. → State the rule: an issue whose walk meets a
  visited key becomes a top itself (crumb as for an off-board parent), and say that in the test line.
- **[I] spec:81–82 — the modal tree descends `childrenOf` with no cycle guard.** §3 guards the parent WALK, but `childrenOf` built from a malformed
  cache can hold A→B→A, and a tree that recurses "each child's own descendants" from it never ends — a render-time stack overflow unmounts the page,
  the exact failure §3 says a malformed list must not cause. → Carry a visited set (or the fold's own depth) into the tree derivation, and add the
  cycle case to the `jira-modal` tests.
- **[I] spec:83 — "as the list does today" is false.** Today's Subtasks row is key, summary and the raw status NAME as a `span`
  (`client/src/components/jira/JiraIssueModal.tsx:72–75`; DESIGN.md §8.9.2 "Body"): no type icon, no assignee initials, no `Pill`. → Say the row is
  new (the mock's), and name the pieces it composes (`TypeIcon` is private to `JiraCard.tsx:114` and would need hoisting; `initialsOf`; `Pill`).
- **[I] spec:58–61 — the band reads `0 issues` while the list is loading or after a failed first read.** `useJiraBoard` returns `NO_ISSUES` while
  `held.id !== id` (`client/src/hooks/useJiraBoard.ts:87`) and on a failed read with no earlier list (`:72`); today `bandSub` draws `board.count` from
  the status in both states (`JiraBoardView.tsx:43,47`; `lib/jira.ts:185`). Taking N from the loaded list regresses the band on every board switch and
  on an unreachable Jira. → Define the fallback: draw the status count with no `as M cards` until the list has landed, or keep `board.count` as N and
  add `as M cards` only when the list is held and `M < N`.
- **[I] spec:58 — the whole band line is not given.** `N issues as M cards` replaces `N issues`, and "the source counts are unchanged", but today the
  sources are a suffix of the SAME part (`lib/jira.ts:185`: `${count} from ${sources}`), so the line is either `17 issues as 5 cards from 2 roots and
  1 query` or `17 issues from 2 roots and 1 query as 5 cards`; the mock has no sources to settle it. → Write the full example line once, with sources,
  and use it in §9's test.
- **[I] spec:100 — the reason `subtasks` stays is false.** The ticket block prints `Subtasks (${detail.children.length})` from the detail's children
  (`server/src/jira/block.ts:76`), never `JiraIssue.subtasks`; and there is no `jira` skill (`skills/` holds the six backlog skills; it is phase 4 in the
  Jira spec §12). The conclusion (leave the wire alone) is fine. → Say "stays on the wire because the server is untouched", or that nothing reads it.
- **[I] spec:69–71 — the "amber marker" has no tone, and the ring's token is the wrong split.** `MarkerTone` is `groomed | kind | done | stale |
  untyped` (`client/src/components/ui/Marker.tsx:3`); the only amber one is `stale` (`--amber-ink`, `styles.css:2888`), whose name says something else.
  The ring's "2 px `--amber`" must be `--amber-solid` (`theme.css:73`: amber as a mark; `styles.css` names bare `--amber` nowhere today). → Name the
  marker tone (a new `match` tone in `--amber-ink`, or `stale` reused and why) and the ring token.
- **[I] spec:108 with spec:32 — "the board's sort for deeper ones" is ambiguous, and `childrenOf` has no stated order.** After §3 the board has TWO
  sorts (tops by newest-under; `sortForBoard` by own `updated`, `lib/jira.ts:75`), and §3 never says `childrenOf`/`under` are sorted — the walk's
  natural order is the server's list order (queries, then roots; `server/src/jira/poller.service.ts:722–733`). The card's `C children · D below them`
  needs no order, the modal tree does. → State it in §3: `childrenOf` lists are `sortForBoard`'s order (own `updated`, key tie-break), and §8 repeats
  that.

## Minor

- spec:5–7 — mock differences not called out: in `GroupTop.dc.html` the fold block is bar → legend, and `4 children · 5 below them` sits IN the marker
  row (first marker), not above it as spec:50–52 orders; `GroupFilter.dc.html` F1 reads `1 matches: PAY-162` (spec: `1 match`) and still draws
  `3 subtasks`; the mock colours the column dots, the repo does not (see the Critical).
- spec:48 — "the parent crumb when the parent is off the board" is not what `crumbOf` does: it gives the parent crumb whenever `parent !== null`
  (`lib/jira.ts`, `crumbOf`). Equivalent for a drawn top (its parent is off-board by definition), but "Unchanged" misdescribes the function.
- spec:30 — a followed ROOT whose parent is also on the board (two roots, one under the other) folds and loses its card and its `root` crumb; the
  band's `from R roots` still counts it. Worth one sentence, since §4 lists `root` first in the crumb precedence.
- spec:52 — `1 child · 1 below them`: "them" with one child. Say the singular (`1 below it`) or accept it in the test's "0/1/many" line.
- spec:57 — "counts cards (tops)": say shown tops (after the filter), as the pill does today (`JiraBoardView.tsx:90`).
- spec:67–73 — under an active filter the fold block's counts and bar are implicitly unfiltered (they read `under`); say so, since the ring's
  marker counts matches and a reader may expect the bar to follow.
- spec:92 — the detail's children are capped at `JIRA_ROOT_CAP` (200) (`poller.service.ts:366`); a board child past that cap is absent from the tree
  though the card counted it. Rare; name it beside the Done-window case.
- spec:114 — `jira-lib (jest, pure)`: `test/jira-lib.test.ts` runs under `@jest-environment jsdom` and uses `renderHook`.
- spec:125–126 — §10 misses two sentences that go stale: DESIGN.md §8.9.1 "Filters" ("the list is by `updated`") and `docs/subsystems/jira.md:194–195`
  (the `lib/jira.ts` paragraph names "subtasks marker").
- spec:4 — "before phase 3" is consistent with Jira spec §12 (phase 3 = writes); fine, noted only because the plan order is load-bearing for the
  `jira-modal` tests, which phase 3 rewrites.

## Checked and found true

- spec:60 — `bandSub` reads `board.count` (`lib/jira.ts:185`). spec:85 — `JiraView.tsx:54` is the modal line; the list lives in `JiraBoardView`'s
  `useJiraBoard` (`:68`). spec:40 — dedup by key, first occurrence wins (`poller.service.ts:727–733`); cap 500 (`:111`). spec:37 — the Done window is
  applied at map time and off for the detail read (`.claude/rules/jira.md`, `poller.service.ts:354–366`). spec:44 — `cardAgeStamp` is `resolved` on
  a Done card with one, else `updated`. spec:49 — no `Run ▾`, no live strip (`JiraCard.tsx:23`). spec:50 — the marker is `subtasksMarker(issue.subtasks)`
  (`JiraCard.tsx:44`). spec:73 — options already derive from the whole loaded list (`JiraBoardView.tsx:76`). spec:89–90 — one `Modal` mount whose
  entry on the Escape stack is a ref updated in place (`useDialogEscape.ts:78–84`), so an in-place issue swap keeps the composer count at five
  (`.claude/rules/board.md`). spec:11 and spec:16 — 29 − 22 = 7. The mocks' `17 as 5`, `4 + 5 = 9 in all` agree with their own columns and rows.
- Hard rules touched: client-only, `lib/jira.ts` one home, no new persisted state, Escape one owner — all respected as written.
